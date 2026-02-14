'use strict';
const fs = require('fs');
const cors = require('cors');
const readline = require('readline');
const winston = require('winston');
const zlib = require('zlib');
const express = require('express');
const http = require('http');
const net = require('net');
const path = require('path');
const { Server } = require('socket.io');
const fsPromises = require('fs').promises;
const PacketProcessor = require('./algo/packet');
const BuffMonitor = require('./algo/buff_monitor');
const Readable = require('stream').Readable;

// 判断是否在pkg打包环境中运行
const isPkg = process.pkg !== undefined;
const basePath = isPkg ? path.dirname(process.execPath) : __dirname;

let cap;
let Cap, decoders, PROTOCOL;
try {
    cap = require('cap');
    if (cap) {
        Cap = cap.Cap;
        decoders = cap.decoders;
        PROTOCOL = cap.decoders.PROTOCOL;
    }
} catch (e) {
    console.error(e);
    console.log('\x1b[33mWarning: Failed to load PCAP module. Starting in mock mode without network capturing.\x1b[0m');
}
const print = console.log;
const app = express();
const { exec } = require('child_process');
// 自动网络设备检测函数
let findDefaultNetworkDevice = async function (devices) {
    // 设备优先级排序
    const devicePriority = (device) => {
        const description = (device.description || device.name).toLowerCase();

        // 排除虚拟设备和回环设备
        if (
            description.includes('virtual') ||
            description.includes('loopback') ||
            description.includes('miniport') ||
            description.includes('bluetooth') ||
            description.includes('tunnel')
        ) {
            return 0;
        }

        // 优先有线网卡
        if (description.includes('ethernet') || description.includes('wired') || description.includes('lan')) {
            return 3;
        }

        // 其次无线网卡
        if (description.includes('wifi') || description.includes('wireless') || description.includes('wi-fi')) {
            return 2;
        }

        // 其他网络设备
        return 1;
    };

    // 按优先级排序设备
    const sortedDevices = devices
        .map((device, index) => ({
            index,
            device,
            priority: devicePriority(device),
        }))
        .filter((item) => item.priority > 0)
        .sort((a, b) => b.priority - a.priority);

    // 返回优先级最高的设备索引
    if (sortedDevices.length > 0) {
        return sortedDevices[0].index;
    }

    return null;
};

const skillConfig = require('./tables/skill_names_new.json');
const VERSION = '3.3.6';
const SETTINGS_PATH = path.join('./settings.json');
let globalSettings = {
    autoClearOnServerChange: true,
    autoClearOnTimeout: false,
    onlyRecordEliteDummy: false,
};

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});
const devices = cap ? cap.deviceList() : [];

// 暂停统计状态
let isPaused = false;

function warnAndExit(text) {
    console.log(`\x1b[31m${text}\x1b[0m`);
    fs.readSync(0, Buffer.alloc(1), 0, 1, null);
    process.exit(1);
}

function safeRequireCap() {
    try {
        return require('cap');
    } catch (e) {
        console.error(e);
        console.log('\x1b[33mWarning: Failed to load PCAP module. Starting in mock mode without network capturing.\x1b[0m');
        return null;
    }
}

function ask(question) {
    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            resolve(answer);
        });
    });
}

function getSubProfessionBySkillId(skillId) {
    switch (skillId) {
        case 1241:
            return '射线';
        case 2307:
        case 2361:
        case 55302:
            return '协奏';
        case 20301:
            return '愈合';
        case 1518:
        case 1541:
        case 21402:
            return '惩戒';
        case 2306:
            return '狂音';
        case 120901:
        case 120902:
            return '冰矛';
        case 1714:
        case 1734:
            return '居合';
        case 44701:
        case 179906:
            return '月刃';
        case 220112:
        case 2203622:
            return '鹰弓';
        case 2292:
        case 1700820:
        case 1700825:
        case 1700827:
            return '狼弓';
        case 1419:
            return '空枪';
        case 1405:
        case 1418:
            return '重装';
        case 2405:
            return '防盾';
        case 2406:
            return '光盾';
        case 199902:
            return '岩盾';
        case 1930:
        case 1931:
        case 1934:
        case 1935:
            return '格挡';
        default:
            return '';
    }
}

class Lock {
    constructor() {
        this.queue = [];
        this.locked = false;
    }

    async acquire() {
        if (this.locked) {
            return new Promise((resolve) => this.queue.push(resolve));
        }
        this.locked = true;
    }

    release() {
        if (this.queue.length > 0) {
            const nextResolve = this.queue.shift();
            nextResolve();
        } else {
            this.locked = false;
        }
    }
}

// 通用统计类，用于处理伤害或治疗数据
class StatisticData {
    constructor(user, type, element, name) {
        this.user = user;
        this.type = type || '';
        this.element = element || '';
        this.name = name || '';
        this.stats = {
            normal: 0,
            critical: 0,
            lucky: 0,
            crit_lucky: 0,
            hpLessen: 0, // 仅用于伤害统计
            total: 0,
        };
        this.count = {
            normal: 0,
            critical: 0,
            lucky: 0,
            total: 0,
        };
        this.realtimeWindow = []; // 实时统计窗口
        this.timeRange = []; // 时间范围 [开始时间, 最后时间]
        this.realtimeStats = {
            value: 0,
            max: 0,
        };
    }

    /** 添加数据记录
     * @param {number} value - 数值
     * @param {boolean} isCrit - 是否为暴击
     * @param {boolean} isLucky - 是否为幸运
     * @param {number} hpLessenValue - 生命值减少量（仅伤害使用）
     */
    addRecord(value, isCrit, isLucky, hpLessenValue = 0) {
        const now = Date.now();

        // 更新数值统计
        if (isCrit) {
            if (isLucky) {
                this.stats.crit_lucky += value;
            } else {
                this.stats.critical += value;
            }
        } else if (isLucky) {
            this.stats.lucky += value;
        } else {
            this.stats.normal += value;
        }
        this.stats.total += value;
        this.stats.hpLessen += hpLessenValue;

        // 更新次数统计
        if (isCrit) {
            this.count.critical++;
        }
        if (isLucky) {
            this.count.lucky++;
        }
        if (!isCrit && !isLucky) {
            this.count.normal++;
        }
        this.count.total++;

        this.realtimeWindow.push({
            time: now,
            value,
        });

        if (this.timeRange[0]) {
            this.timeRange[1] = now;
        } else {
            this.timeRange[0] = now;
        }
    }

    /** 更新实时统计 */
    updateRealtimeStats() {
        const now = Date.now();

        // 清除超过1秒的数据
        while (this.realtimeWindow.length > 0 && now - this.realtimeWindow[0].time > 1000) {
            this.realtimeWindow.shift();
        }

        // 计算当前实时值
        this.realtimeStats.value = 0;
        for (const entry of this.realtimeWindow) {
            this.realtimeStats.value += entry.value;
        }

        // 更新最大值
        if (this.realtimeStats.value > this.realtimeStats.max) {
            this.realtimeStats.max = this.realtimeStats.value;
        }
    }

    /** 计算总的每秒统计值 */
    getTotalPerSecond() {
        if (!this.timeRange[0] || !this.timeRange[1]) {
            return 0;
        }
        const totalPerSecond = (this.stats.total / (this.timeRange[1] - this.timeRange[0])) * 1000 || 0;
        if (!Number.isFinite(totalPerSecond)) return 0;
        return totalPerSecond;
    }

    /** 重置数据 */
    reset() {
        this.stats = {
            normal: 0,
            critical: 0,
            lucky: 0,
            crit_lucky: 0,
            hpLessen: 0,
            total: 0,
        };
        this.count = {
            normal: 0,
            critical: 0,
            lucky: 0,
            total: 0,
        };
        this.realtimeWindow = [];
        this.timeRange = [];
        this.realtimeStats = {
            value: 0,
            max: 0,
        };
    }
}

class UserData {
    constructor(uid) {
        this.uid = uid;
        this.name = '';
        this.damageStats = new StatisticData(this, '伤害');
        this.healingStats = new StatisticData(this, '治疗');
        this.takenDamage = 0; // 承伤
        this.deadCount = 0; // 死亡次数
        this.profession = '未知';
        this.skillUsage = new Map(); // 技能使用情况
        this.fightPoint = 0; // 总评分
        this.subProfession = '';
        this.attr = {};
    }

    /** 添加伤害记录
     * @param {number} skillId - 技能ID/Buff ID
     * @param {string} element - 技能元素属性
     * @param {number} damage - 伤害值
     * @param {boolean} isCrit - 是否为暴击
     * @param {boolean} [isLucky] - 是否为幸运
     * @param {boolean} [isCauseLucky] - 是否造成幸运
     * @param {number} hpLessenValue - 生命值减少量
     */
    addDamage(skillId, element, damage, isCrit, isLucky, isCauseLucky, hpLessenValue = 0) {
        this.damageStats.addRecord(damage, isCrit, isLucky, hpLessenValue);
        // 记录技能使用情况
        const skillName = skillConfig[skillId] ?? skillId;
        if (!this.skillUsage.has('伤害-' + skillName)) {
            this.skillUsage.set('伤害-' + skillName, new StatisticData(this, '伤害', element, skillName));
        }
        this.skillUsage.get('伤害-' + skillName).addRecord(damage, isCrit, isCauseLucky, hpLessenValue);
        this.skillUsage.get('伤害-' + skillName).realtimeWindow.length = 0;

        const subProfession = getSubProfessionBySkillId(skillId);
        if (subProfession) {
            this.setSubProfession(subProfession);
        }
    }

    /** 添加治疗记录
     * @param {number} skillId - 技能ID/Buff ID
     * @param {string} element - 技能元素属性
     * @param {number} healing - 治疗值
     * @param {boolean} isCrit - 是否为暴击
     * @param {boolean} [isLucky] - 是否为幸运
     * @param {boolean} [isCauseLucky] - 是否造成幸运
     */
    addHealing(skillId, element, healing, isCrit, isLucky, isCauseLucky) {
        this.healingStats.addRecord(healing, isCrit, isLucky);
        // 记录技能使用情况
        const skillName = skillConfig[skillId] ?? skillId;
        if (!this.skillUsage.has('治疗-' + skillName)) {
            this.skillUsage.set('治疗-' + skillName, new StatisticData(this, '治疗', element, skillName));
        }
        this.skillUsage.get('治疗-' + skillName).addRecord(healing, isCrit, isCauseLucky);
        this.skillUsage.get('治疗-' + skillName).realtimeWindow.length = 0;

        const subProfession = getSubProfessionBySkillId(skillId);
        if (subProfession) {
            this.setSubProfession(subProfession);
        }
    }

    /** 添加承伤记录
     * @param {number} damage - 承受的伤害值
     * @param {boolean} isDead - 是否致死伤害
     * */
    addTakenDamage(damage, isDead) {
        this.takenDamage += damage;
        if (isDead) this.deadCount++;
    }

    /** 更新实时DPS和HPS 计算过去1秒内的总伤害和治疗 */
    updateRealtimeDps() {
        this.damageStats.updateRealtimeStats();
        this.healingStats.updateRealtimeStats();
    }

    /** 计算总DPS */
    getTotalDps() {
        return this.damageStats.getTotalPerSecond();
    }

    /** 计算总HPS */
    getTotalHps() {
        return this.healingStats.getTotalPerSecond();
    }

    /** 获取合并的次数统计 */
    getTotalCount() {
        return {
            normal: this.damageStats.count.normal + this.healingStats.count.normal,
            critical: this.damageStats.count.critical + this.healingStats.count.critical,
            lucky: this.damageStats.count.lucky + this.healingStats.count.lucky,
            total: this.damageStats.count.total + this.healingStats.count.total,
        };
    }

    /** 获取用户数据摘要 */
    getSummary() {
        return {
            realtime_dps: this.damageStats.realtimeStats.value,
            realtime_dps_max: this.damageStats.realtimeStats.max,
            total_dps: this.getTotalDps(),
            total_damage: { ...this.damageStats.stats },
            total_count: this.getTotalCount(),
            realtime_hps: this.healingStats.realtimeStats.value,
            realtime_hps_max: this.healingStats.realtimeStats.max,
            total_hps: this.getTotalHps(),
            total_healing: { ...this.healingStats.stats },
            taken_damage: this.takenDamage,
            profession: this.profession + (this.subProfession ? `-${this.subProfession}` : ''),
            name: this.name,
            fightPoint: this.fightPoint,
            hp: this.attr.hp,
            max_hp: this.attr.max_hp,
            dead_count: this.deadCount,
        };
    }

    /** 获取技能统计数据 */
    getSkillSummary() {
        const skills = {};
        for (const [skillKey, stat] of this.skillUsage) {
            const total = stat.stats.normal + stat.stats.critical + stat.stats.lucky + stat.stats.crit_lucky;
            const critCount = stat.count.critical;
            const luckyCount = stat.count.lucky;
            const critRate = stat.count.total > 0 ? critCount / stat.count.total : 0;
            const luckyRate = stat.count.total > 0 ? luckyCount / stat.count.total : 0;
            const name = stat.name ?? skillKey;
            const elementype = stat.element;

            skills[skillKey] = {
                displayName: name,
                type: stat.type,
                elementype: elementype,
                totalDamage: stat.stats.total,
                totalCount: stat.count.total,
                critCount: stat.count.critical,
                luckyCount: stat.count.lucky,
                critRate: critRate,
                luckyRate: luckyRate,
                damageBreakdown: { ...stat.stats },
                countBreakdown: { ...stat.count },
            };
        }
        return skills;
    }

    /** 设置职业
     * @param {string} profession - 职业名称
     * */
    setProfession(profession) {
        if (profession !== this.profession) this.setSubProfession('');
        this.profession = profession;
    }

    /** 设置子职业
     * @param {string} subProfession - 子职业名称
     * */
    setSubProfession(subProfession) {
        this.subProfession = subProfession;
    }

    /** 设置姓名
     * @param {string} name - 姓名
     * */
    setName(name) {
        this.name = name;
    }

    /** 设置用户总评分
     * @param {number} fightPoint - 总评分
     */
    setFightPoint(fightPoint) {
        this.fightPoint = fightPoint;
    }

    /** 设置额外数据
     * @param {string} key
     * @param {any} value
     */
    setAttrKV(key, value) {
        this.attr[key] = value;
    }

    /** 重置数据 预留 */
    reset() {
        this.damageStats.reset();
        this.healingStats.reset();
        this.takenDamage = 0;
        this.skillUsage.clear();
        this.fightPoint = 0;
    }
}

// 用户数据管理器
class UserDataManager {
    constructor(logger) {
        this.logger = logger;
        this.users = new Map();
        this.userCache = new Map(); // 用户名字和职业缓存
        this.cacheFilePath = './users.json';

        // 节流相关配置
        this.saveThrottleDelay = 2000; // 2秒节流延迟，避免频繁磁盘写入
        this.saveThrottleTimer = null;
        this.pendingSave = false;

        this.hpCache = new Map(); // 这个经常变化的就不存盘了
        this.startTime = Date.now();

        this.logLock = new Lock();
        this.logDirExist = new Set();
        this.logStreams = new Map();

        this.enemyCache = {
            name: new Map(),
            hp: new Map(),
            maxHp: new Map(),
        };
        this.maxHpMonster = '';

        // Buff监控
        this.buffMonitor = new BuffMonitor(logger);

        // 自动保存
        this.lastAutoSaveTime = 0;
        this.lastLogTime = 0;
        setInterval(() => {
            if (this.lastLogTime < this.lastAutoSaveTime) return;
            this.lastAutoSaveTime = Date.now();
            this.saveAllUserData();
        }, 10 * 1000);
    }

    /** 初始化方法 - 异步加载用户缓存 */
    async initialize() {
        await this.loadUserCache();
    }

    /** 加载用户缓存 */
    async loadUserCache() {
        try {
            await fsPromises.access(this.cacheFilePath);
            const data = await fsPromises.readFile(this.cacheFilePath, 'utf8');
            const cacheData = JSON.parse(data);
            this.userCache = new Map(Object.entries(cacheData));
            this.logger.info(`Loaded ${this.userCache.size} user cache entries`);
        } catch (error) {
            if (error.code !== 'ENOENT') {
                this.logger.error('Failed to load user cache:', error);
            }
        }
    }

    /** 保存用户缓存 */
    async saveUserCache() {
        try {
            const cacheData = Object.fromEntries(this.userCache);
            await fsPromises.writeFile(this.cacheFilePath, JSON.stringify(cacheData, null, 2), 'utf8');
        } catch (error) {
            this.logger.error('Failed to save user cache:', error);
        }
    }

    /** 清空用户缓存 */
    async clearUserCache() {
        const count = this.userCache.size;
        this.userCache.clear();
        this.users.clear();
        await fsPromises.writeFile(this.cacheFilePath, '{}', 'utf8');
        this.logger.info(`User cache cleared, removed ${count} entries`);
    }

    /** 节流保存用户缓存 - 减少频繁的磁盘写入 */
    saveUserCacheThrottled() {
        this.pendingSave = true;

        if (this.saveThrottleTimer) {
            clearTimeout(this.saveThrottleTimer);
        }

        this.saveThrottleTimer = setTimeout(async () => {
            if (this.pendingSave) {
                await this.saveUserCache();
                this.pendingSave = false;
                this.saveThrottleTimer = null;
            }
        }, this.saveThrottleDelay);
    }

    /** 强制立即保存用户缓存 - 用于程序退出等场景 */
    async forceUserCacheSave() {
        isPaused = true;
        this.logger.info('Saving user cache...');
        await this.saveAllUserData(this.users, this.startTime);
        if (this.saveThrottleTimer) {
            clearTimeout(this.saveThrottleTimer);
            this.saveThrottleTimer = null;
        }
        if (this.pendingSave) {
            await this.saveUserCache();
            this.pendingSave = false;
        }

        // 关闭全部的日志流
        this.logger.info(`Waiting for ${this.logStreams.size} log stream to close`);
        for (const [logFile, gzip] of this.logStreams.entries()) {
            gzip.end();
            await new Promise((r) => gzip.on('close', r));
        }
    }

    /** 获取或创建用户记录
     * @param {number} uid - 用户ID
     * @returns {UserData} - 用户数据实例
     */
    getUser(uid) {
        if (!this.users.has(uid)) {
            const user = new UserData(uid);

            // 从缓存中设置名字和职业
            const cachedData = this.userCache.get(String(uid));
            if (cachedData) {
                if (cachedData.name) {
                    user.setName(cachedData.name);
                }
                if (cachedData.profession) {
                    user.setProfession(cachedData.profession);
                }
                if (cachedData.fightPoint !== undefined && cachedData.fightPoint !== null) {
                    user.setFightPoint(cachedData.fightPoint);
                }
                if (cachedData.maxHp !== undefined && cachedData.maxHp !== null) {
                    user.setAttrKV('max_hp', cachedData.maxHp);
                }
            }
            if (this.hpCache.has(uid)) {
                user.setAttrKV('hp', this.hpCache.get(uid));
            }

            this.users.set(uid, user);
        }
        return this.users.get(uid);
    }

    /** 添加伤害记录
     * @param {number} uid - 造成伤害的用户ID
     * @param {number} skillId - 技能ID/Buff ID
     * @param {string} element - 技能元素属性
     * @param {number} damage - 伤害值
     * @param {boolean} isCrit - 是否为暴击
     * @param {boolean} [isLucky] - 是否为幸运
     * @param {boolean} [isCauseLucky] - 是否造成幸运
     * @param {number} hpLessenValue - 生命值减少量
     * @param {number} targetUid - 伤害目标ID
     */
    addDamage(uid, skillId, element, damage, isCrit, isLucky, isCauseLucky, hpLessenValue = 0, targetUid) {
        if (isPaused) return;
        if (globalSettings.onlyRecordEliteDummy && targetUid !== 75) return;
        this.checkTimeoutClear();
        const user = this.getUser(uid);
        user.addDamage(skillId, element, damage, isCrit, isLucky, isCauseLucky, hpLessenValue);
    }

    /** 添加治疗记录
     * @param {number} uid - 进行治疗的用户ID
     * @param {number} skillId - 技能ID/Buff ID
     * @param {string} element - 技能元素属性
     * @param {number} healing - 治疗值
     * @param {boolean} isCrit - 是否为暴击
     * @param {boolean} [isLucky] - 是否为幸运
     * @param {boolean} [isCauseLucky] - 是否造成幸运
     * @param {number} targetUid - 被治疗的用户ID
     */
    addHealing(uid, skillId, element, healing, isCrit, isLucky, isCauseLucky, targetUid) {
        if (isPaused) return;
        this.checkTimeoutClear();
        if (uid !== 0) {
            const user = this.getUser(uid);
            user.addHealing(skillId, element, healing, isCrit, isLucky, isCauseLucky);
        }
    }

    /** 添加承伤记录
     * @param {number} uid - 承受伤害的用户ID
     * @param {number} damage - 承受的伤害值
     * @param {boolean} isDead - 是否致死伤害
     * */
    addTakenDamage(uid, damage, isDead) {
        if (isPaused) return;
        this.checkTimeoutClear();
        const user = this.getUser(uid);
        user.addTakenDamage(damage, isDead);
    }

    /** 添加日志记录
     * @param {string} log - 日志内容
     * */
    async addLog(log) {
        if (isPaused) return;

        const logDir = path.join('./logs', String(this.startTime));
        const logFile = path.join(logDir, 'fight.log.gz');
        const timestamp = new Date().toISOString();
        const logEntry = `[${timestamp}] ${log}\n`;

        this.lastLogTime = Date.now();

        await this.logLock.acquire();
        try {
            if (!this.logDirExist.has(logDir)) {
                await fsPromises.mkdir(logDir, { recursive: true });
                this.logDirExist.add(logDir);
            }

            if (!this.logStreams.has(logFile)) {
                const gzip = zlib.createGzip();
                const fileStream = fs.createWriteStream(logFile, { flags: 'a' });
                gzip.pipe(fileStream);
                this.logStreams.set(logFile, gzip);
            }
            const gzipStream = this.logStreams.get(logFile);
            gzipStream.write(logEntry);
        } catch (error) {
            this.logger.error('Failed to save log:', error);
        }
        this.logLock.release();
    }

    /** 设置用户职业
     * @param {number} uid - 用户ID
     * @param {string} profession - 职业名称
     * */
    setProfession(uid, profession) {
        const user = this.getUser(uid);
        if (user.profession !== profession) {
            user.setProfession(profession);
            this.logger.info(`Found profession ${profession} for uid ${uid}`);

            // 更新缓存
            const uidStr = String(uid);
            if (!this.userCache.has(uidStr)) {
                this.userCache.set(uidStr, {});
            }
            this.userCache.get(uidStr).profession = profession;
            this.saveUserCacheThrottled();
        }
    }

    /** 设置用户姓名
     * @param {number} uid - 用户ID
     * @param {string} name - 姓名
     * */
    setName(uid, name) {
        const user = this.getUser(uid);
        if (user.name !== name) {
            user.setName(name);
            this.logger.info(`Found player name ${name} for uid ${uid}`);

            // 更新缓存
            const uidStr = String(uid);
            if (!this.userCache.has(uidStr)) {
                this.userCache.set(uidStr, {});
            }
            this.userCache.get(uidStr).name = name;
            this.saveUserCacheThrottled();
        }
    }

    /** 设置用户总评分
     * @param {number} uid - 用户ID
     * @param {number} fightPoint - 总评分
     */
    setFightPoint(uid, fightPoint) {
        const user = this.getUser(uid);
        if (user.fightPoint != fightPoint) {
            user.setFightPoint(fightPoint);
            this.logger.info(`Found fight point ${fightPoint} for uid ${uid}`);

            // 更新缓存
            const uidStr = String(uid);
            if (!this.userCache.has(uidStr)) {
                this.userCache.set(uidStr, {});
            }
            this.userCache.get(uidStr).fightPoint = fightPoint;
            this.saveUserCacheThrottled();
        }
    }

    /** 设置额外数据
     * @param {number} uid - 用户ID
     * @param {string} key
     * @param {any} value
     */
    setAttrKV(uid, key, value) {
        const user = this.getUser(uid);
        user.attr[key] = value;

        if (key === 'max_hp') {
            // 更新缓存
            const uidStr = String(uid);
            if (!this.userCache.has(uidStr)) {
                this.userCache.set(uidStr, {});
            }
            this.userCache.get(uidStr).maxHp = value;
            this.saveUserCacheThrottled();
        }
        if (key === 'hp') {
            this.hpCache.set(uid, value);
        }
    }

    /** 更新所有用户的实时DPS和HPS */
    updateAllRealtimeDps() {
        for (const user of this.users.values()) {
            user.updateRealtimeDps();
        }
    }

    /** 获取用户的技能数据 */
    getUserSkillData(uid) {
        const user = this.users.get(uid);
        if (!user) return null;

        return {
            uid: user.uid,
            name: user.name,
            profession: user.profession + (user.subProfession ? `-${user.subProfession}` : ''),
            skills: user.getSkillSummary(),
            attr: user.attr,
        };
    }

    /** 获取所有用户数据 */
    getAllUsersData() {
        const result = {};
        for (const [uid, user] of this.users.entries()) {
            result[uid] = user.getSummary();
        }
        return result;
    }

    /** 获取所有敌方缓存数据 */
    getAllEnemiesData() {
        const result = {};
        const enemyIds = new Set([...this.enemyCache.name.keys(), ...this.enemyCache.hp.keys(), ...this.enemyCache.maxHp.keys()]);
        enemyIds.forEach((id) => {
            result[id] = {
                id: (BigInt(id) >> 16n).toString(),
                name: this.enemyCache.name.get(id),
                hp: this.enemyCache.hp.get(id),
                max_hp: this.enemyCache.maxHp.get(id),
            };
        });
        return result;
    }

    /** 移除敌方缓存数据 */
    deleteEnemyData(id) {
        this.enemyCache.name.delete(id);
        this.enemyCache.hp.delete(id);
        this.enemyCache.maxHp.delete(id);
    }

    /** 清空敌方缓存 */
    refreshEnemyCache() {
        let maxHpMonsterId = 0;
        for (const [id, hp] of this.enemyCache.maxHp.entries()) {
            if (!maxHpMonsterId || hp > this.enemyCache.maxHp.get(maxHpMonsterId)) {
                maxHpMonsterId = id;
            }
        }
        if (maxHpMonsterId && this.enemyCache.name.has(maxHpMonsterId)) {
            this.maxHpMonster = this.enemyCache.name.get(maxHpMonsterId);
        }
        this.enemyCache.name.clear();
        this.enemyCache.hp.clear();
        this.enemyCache.maxHp.clear();
    }

    /** 清除所有用户数据 */
    clearAll() {
        const usersToSave = this.users;
        const saveStartTime = this.startTime;
        const logDir = path.join('./logs', String(this.startTime));
        const logFile = path.join(logDir, 'fight.log.gz');
        const gzipStream = this.logStreams.get(logFile);

        this.users = new Map();
        this.startTime = Date.now();
        this.lastAutoSaveTime = 0;
        this.lastLogTime = 0;
        this.resetBuffState();
        this.saveAllUserData(usersToSave, saveStartTime);

        if (gzipStream) {
            // 关闭日志流
            gzipStream.end();
            gzipStream.on('close', () => {
                this.logStreams.delete(logFile);
            });
        }
    }

    /** 获取用户列表 */
    getUserIds() {
        return Array.from(this.users.keys());
    }

    /** 保存所有用户数据到历史记录
     * @param {Map} usersToSave - 要保存的用户数据Map
     * @param {number} startTime - 数据开始时间
     */
    async saveAllUserData(usersToSave = null, startTime = null) {
        try {
            const endTime = Date.now();
            const users = usersToSave || this.users;
            const timestamp = startTime || this.startTime;
            const logDir = path.join('./logs', String(timestamp));
            const usersDir = path.join(logDir, 'users');
            const summary = {
                startTime: timestamp,
                endTime,
                duration: endTime - timestamp,
                userCount: users.size,
                version: VERSION,
                maxHpMonster: '',
            };

            let maxHpMonsterId = '';
            for (const [id, hp] of this.enemyCache.maxHp.entries()) {
                if (!maxHpMonsterId || hp > this.enemyCache.maxHp.get(maxHpMonsterId)) {
                    maxHpMonsterId = id;
                }
            }
            if (maxHpMonsterId && this.enemyCache.name.has(maxHpMonsterId)) {
                summary.maxHpMonster = this.enemyCache.name.get(maxHpMonsterId);
            }
            if (!summary.maxHpMonster) {
                summary.maxHpMonster = this.maxHpMonster;
                this.maxHpMonster = '';
            }

            const allUsersData = {};
            const userDatas = new Map();
            for (const [uid, user] of users.entries()) {
                allUsersData[uid] = user.getSummary();

                const userData = {
                    uid: user.uid,
                    name: user.name,
                    profession: user.profession + (user.subProfession ? `-${user.subProfession}` : ''),
                    skills: user.getSkillSummary(),
                    attr: user.attr,
                };
                userDatas.set(uid, userData);
            }

            try {
                await fsPromises.access(usersDir);
            } catch (error) {
                await fsPromises.mkdir(usersDir, { recursive: true });
            }

            // 保存所有用户数据汇总
            const allUserDataPath = path.join(logDir, 'allUserData.json');
            await fsPromises.writeFile(allUserDataPath, JSON.stringify(allUsersData, null, 2), 'utf8');

            // 保存每个用户的详细数据
            for (const [uid, userData] of userDatas.entries()) {
                const userDataPath = path.join(usersDir, `${uid}.json`);
                await fsPromises.writeFile(userDataPath, JSON.stringify(userData, null, 2), 'utf8');
            }

            await fsPromises.writeFile(path.join(logDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');

            this.logger.debug(`Saved data for ${summary.userCount} users to ${logDir}`);
        } catch (error) {
            this.logger.error('Failed to save all user data:', error);
            throw error;
        }
    }

    checkTimeoutClear() {
        if (!globalSettings.autoClearOnTimeout || this.lastLogTime === 0 || this.users.size === 0) return;
        const currentTime = Date.now();
        if (this.lastLogTime && currentTime - this.lastLogTime > 15000) {
            this.clearAll();
            this.logger.info('Timeout reached, statistics cleared!');
        }
    }

    getGlobalSettings() {
        return globalSettings;
    }

    /** 获取活跃的buff数据 */
    getActiveBuffs() {
        if (this.buffMonitor) {
            const buffs = this.buffMonitor.getActiveBuffs();
            // 如果没有真实buff数据且在模拟模式下，返回mock数据
            if (Object.keys(buffs).length === 0 && !cap) {
                return this.getMockBuffs();
            }
            return buffs;
        }
        // 如果没有buffMonitor，返回mock数据
        return this.getMockBuffs();
    }

    /** 获取buff配置 */
    getBuffConfig() {
        if (this.buffMonitor) {
            return {
                enabledBuffs: Array.from(this.buffMonitor.buffConfig.enabledBuffs),
                showUnmapped: this.buffMonitor.buffConfig.showUnmapped,
            };
        }
        return { enabledBuffs: [], showUnmapped: true };
    }

    /** 设置buff启用状态 */
    setBuffEnabled(buffId, enabled) {
        if (this.buffMonitor) {
            this.buffMonitor.setBuffEnabled(buffId, enabled);
        }
    }

    /** 设置是否显示未映射的buff */
    setShowUnmapped(show) {
        if (this.buffMonitor) {
            this.buffMonitor.setShowUnmapped(show);
        }
    }

    /** 搜索buff */
    searchBuffs(keyword) {
        if (this.buffMonitor) {
            return this.buffMonitor.searchBuffs(keyword);
        }
        return [];
    }

    /** 获取所有buff */
    getAllBuffs() {
        if (this.buffMonitor) {
            const allBuffs = [];
            const seen = new Set();
            const enabledBuffs = this.buffMonitor.buffConfig.enabledBuffs;
            const allEnabled = enabledBuffs.size === 0;

            for (const [id, name] of Object.entries(this.buffMonitor.buffMap)) {
                if (!seen.has(id)) {
                    allBuffs.push({
                        id,
                        name,
                        enabled: allEnabled || enabledBuffs.has(id),
                        mapped: true,
                    });
                    seen.add(id);
                }
            }

            for (const [id, info] of Object.entries(this.buffMonitor.buffSeen)) {
                if (!seen.has(id)) {
                    allBuffs.push({
                        id,
                        name: '(未映射)',
                        enabled: allEnabled || enabledBuffs.has(id),
                        mapped: false,
                    });
                    seen.add(id);
                }
            }

            return allBuffs.sort((a, b) => {
                if (a.mapped !== b.mapped) {
                    return a.mapped ? -1 : 1;
                }
                return parseInt(a.id) - parseInt(b.id);
            });
        }
        return [];
    }

    /** 全选/全不选Buff */
    selectAllBuffs(enabled) {
        if (this.buffMonitor) {
            this.buffMonitor.selectAllBuffs(enabled);
        }
    }

    /** 获取所有已知玩家角色列表 */
    getEntityUids() {
        const result = [];
        const seenUids = new Set();

        // 检测是否包含乱码（控制字符或不可打印字符）
        const hasGarbledText = (text) => {
            if (!text) return true;
            // 检测控制字符（除了常见的空白字符）
            return /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/.test(text);
        };

        // 先添加有buff的角色
        if (this.buffMonitor) {
            const buffUids = this.buffMonitor.getEntityUids();
            for (const uid of buffUids) {
                const numUid = parseInt(uid);
                const userData = this.getUser(numUid);
                let name = userData?.name || this.userCache.get(String(numUid))?.name || `角色${uid}`;
                // 如果名字有乱码，使用默认名字
                if (hasGarbledText(name)) {
                    name = `角色${uid}`;
                }
                result.push({
                    uid: uid,
                    name: name,
                });
                seenUids.add(String(uid));
            }
        }

        // 再添加userCache中的其他角色
        for (const [uidStr, cacheData] of this.userCache.entries()) {
            if (!seenUids.has(uidStr) && cacheData.name && !hasGarbledText(cacheData.name)) {
                result.push({
                    uid: parseInt(uidStr),
                    name: cacheData.name,
                });
                seenUids.add(uidStr);
            }
        }

        // 最后添加users中的其他角色
        for (const [uid, userData] of this.users.entries()) {
            const uidStr = String(uid);
            if (!seenUids.has(uidStr) && userData.name && !hasGarbledText(userData.name)) {
                result.push({
                    uid: uid,
                    name: userData.name,
                });
                seenUids.add(uidStr);
            }
        }

        return result;
    }

    /** 获取buff映射表 */
    getBuffMap() {
        if (this.buffMonitor) {
            return this.buffMonitor.buffMap;
        }
        return {};
    }

    /** 设置buff映射 */
    setBuffMap(id, name) {
        if (this.buffMonitor) {
            this.buffMonitor.buffMap[id] = name;
            this.buffMonitor.saveBuffMap();
            return { code: 0, msg: '映射设置成功' };
        }
        return { code: 1, msg: 'BuffMonitor未初始化' };
    }

    /** 删除buff映射 */
    deleteBuffMap(id) {
        if (this.buffMonitor) {
            if (this.buffMonitor.buffMap[id]) {
                delete this.buffMonitor.buffMap[id];
                this.buffMonitor.saveBuffMap();
                return { code: 0, msg: '映射删除成功' };
            }
            return { code: 1, msg: '映射不存在' };
        }
        return { code: 1, msg: 'BuffMonitor未初始化' };
    }

    /** 获取模拟buff数据 */
    getMockBuffs() {
        const now = Date.now();
        // 从buff_map.json加载映射
        const buffMap = this.loadBuffMap();

        // 使用真实的buffID，与天才重装妹妹保持一致
        return {
            31201: {
                name: buffMap['31201'] ?? '风姿卓绝',
                durUntil: now + 30000, // 30秒
                stack: 1,
            },
            2205261: {
                name: buffMap['2205261'] ?? '风雷破击',
                durUntil: now + 45000, // 45秒
                stack: 2,
            },
            2205391: {
                name: buffMap['2205391'] ?? '气劲加持',
                durUntil: now + 60000, // 60秒
                stack: 1,
            },
            2205501: {
                name: buffMap['2205501'] ?? '爆炎螺旋',
                durUntil: now + 15000, // 15秒
                stack: 1,
            },
            31602: {
                name: buffMap['31602'] ?? '激励',
                durUntil: now + 20000, // 20秒
                stack: 1,
            },
            43201: {
                name: buffMap['43201'] ?? '千雷闪影之意',
                durUntil: now + 35000, // 35秒
                stack: 1,
            },
        };
    }

    /** 加载buff映射 */
    loadBuffMap() {
        try {
            const buffMapPath = path.join(basePath, 'tables', 'buff_map.json');
            if (fs.existsSync(buffMapPath)) {
                const content = fs.readFileSync(buffMapPath, 'utf8');
                return JSON.parse(content);
            }
        } catch (error) {
            this.logger?.error('Failed to load buff_map.json:', error);
        }
        return {};
    }

    /** 重置所有buff状态 */
    resetBuffState() {
        if (this.buffMonitor) {
            this.buffMonitor.resetAllState();
        }
    }
}

async function main() {
    print('Welcome to use Damage Counter for Star Resonance!');
    print(`Version: V${VERSION}`);
    print('GitHub: https://github.com/dmlgzs/StarResonanceDamageCounter');

    // 从命令行参数获取设备号和日志级别
    const args = process.argv.slice(2);
    let num = args[0];
    let log_level = args[1];

    // 如果cap为null，进入模拟模式
    if (!cap) {
        print('\x1b[33mStarting in mock mode without network capturing.\x1b[0m');
        log_level = log_level || 'info';
        rl.close();
        await startServer(log_level);
        return;
    }

    // 显示可用设备
    for (let i = 0; i < devices.length; i++) {
        print(String(i).padStart(2, ' ') + '.' + (devices[i].description || devices[i].name));
    }

    if (num === 'auto' && cap && findDefaultNetworkDevice) {
        print('Auto detecting default network interface...');
        const device_num = await findDefaultNetworkDevice(devices);
        if (device_num) {
            num = device_num;
            print(`Using network interface: ${num} - ${devices[num].description}`);
        } else {
            print('Default network interface not found!');
            num = undefined;
        }
    }

    // 参数验证函数
    function isValidLogLevel(level) {
        return ['info', 'debug'].includes(level);
    }

    // 如果命令行没传或者不合法，使用交互
    while (num === undefined || !devices[num]) {
        num = await ask('Please enter the number of the device to capture: ');
        if (!num && cap && findDefaultNetworkDevice) {
            print('Auto detecting default network interface...');
            const device_num = await findDefaultNetworkDevice(devices);
            if (device_num) {
                num = device_num;
                print(`Using network interface: ${num} - ${devices[num].description}`);
            } else {
                print('Default network interface not found!');
                num = undefined;
            }
        }
        if (!devices[num]) {
            print('Cannot find device ' + num + '!');
        }
    }
    while (log_level === undefined || !isValidLogLevel(log_level)) {
        log_level = (await ask('Please enter log level (info|debug): ')) || 'info';
        if (!isValidLogLevel(log_level)) {
            print('Invalid log level!');
        }
    }

    rl.close();
    await startServer(log_level, num);
}

async function startServer(log_level, num) {
    const logger = winston.createLogger({
        level: log_level,
        format: winston.format.combine(
            winston.format.colorize({ all: true }),
            winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
            winston.format.printf((info) => {
                return `[${info.timestamp}] [${info.level}] ${info.message}`;
            }),
        ),
        transports: [new winston.transports.Console()],
    });

    const userDataManager = new UserDataManager(logger);

    // 异步初始化用户数据管理器
    await userDataManager.initialize();

    // 进程退出时保存用户缓存
    process.on('SIGINT', async () => {
        await userDataManager.forceUserCacheSave();
        process.exit(0);
    });

    process.on('SIGTERM', async () => {
        await userDataManager.forceUserCacheSave();
        process.exit(0);
    });

    //瞬时DPS更新
    setInterval(() => {
        if (!isPaused) {
            userDataManager.updateAllRealtimeDps();
        }
    }, 100);

    //express 和 socket.io 设置
    app.use(cors());
    app.use(express.json()); // 解析JSON请求体
    app.use(express.static(path.join(basePath, 'public'))); // 静态文件服务
    const server = http.createServer(app);
    const io = new Server(server, {
        cors: {
            origin: '*',
            methods: ['GET', 'POST'],
        },
    });

    app.get('/api/data', (req, res) => {
        const userData = userDataManager.getAllUsersData();
        const enemiesData = userDataManager.getAllEnemiesData();
        const buffData = userDataManager.getActiveBuffs();
        const entityUids = userDataManager.getEntityUids();
        const data = {
            code: 0,
            user: userData,
            enemy: enemiesData,
            buff: buffData,
            entityUids: entityUids,
        };
        res.json(data);
    });

    app.get('/api/buffs', (req, res) => {
        const entityUid = req.query.entityUid ? parseInt(req.query.entityUid) : null;
        const buffData = userDataManager.getActiveBuffs(entityUid);
        const entityUids = userDataManager.getEntityUids();
        const data = {
            code: 0,
            buff: buffData,
            entityUids: entityUids,
        };
        res.json(data);
    });

    app.get('/api/buffs/config', (req, res) => {
        const config = userDataManager.getBuffConfig();
        res.json({
            code: 0,
            config,
        });
    });

    app.post('/api/buffs/config', (req, res) => {
        const { buffId, enabled } = req.body;
        if (buffId === undefined || enabled === undefined) {
            return res.status(400).json({ code: 1, msg: 'Missing buffId or enabled' });
        }
        userDataManager.setBuffEnabled(buffId, enabled);
        res.json({
            code: 0,
            msg: `Buff ${buffId} ${enabled ? 'enabled' : 'disabled'}`,
        });
    });

    app.post('/api/buffs/config/unmapped', (req, res) => {
        const { show } = req.body;
        userDataManager.setShowUnmapped(show);
        res.json({
            code: 0,
            msg: `Unmapped buffs ${show ? 'shown' : 'hidden'}`,
        });
    });

    app.get('/api/buffs/search', (req, res) => {
        const keyword = req.query.q || '';
        const results = userDataManager.searchBuffs(keyword);
        res.json({
            code: 0,
            results,
        });
    });

    app.get('/api/buffs/all', (req, res) => {
        const allBuffs = userDataManager.getAllBuffs();
        res.json({
            code: 0,
            buffs: allBuffs,
        });
    });

    app.post('/api/buffs/config/selectall', (req, res) => {
        const { enabled } = req.body;
        userDataManager.selectAllBuffs(enabled);
        res.json({
            code: 0,
            msg: `All buffs ${enabled ? 'enabled' : 'disabled'}`,
        });
    });

    // Buff映射管理API
    app.get('/api/buffs/map', (req, res) => {
        const buffMap = userDataManager.getBuffMap();
        res.json({
            code: 0,
            map: buffMap,
        });
    });

    // 清空用户缓存
    app.post('/api/cache/clear', async (req, res) => {
        try {
            await userDataManager.clearUserCache();
            res.json({
                code: 0,
                msg: '缓存已清空',
            });
        } catch (error) {
            res.json({
                code: 1,
                msg: error.message,
            });
        }
    });

    app.post('/api/buffs/map', (req, res) => {
        const { id, name } = req.body;
        if (!id || !name) {
            return res.json({ code: 1, msg: '缺少id或name参数' });
        }
        const result = userDataManager.setBuffMap(id, name);
        res.json(result);
    });

    app.delete('/api/buffs/map/:id', (req, res) => {
        const { id } = req.params;
        const result = userDataManager.deleteBuffMap(id);
        res.json(result);
    });

    app.put('/api/buffs/map/:id', (req, res) => {
        const { id } = req.params;
        const { name } = req.body;
        if (!name) {
            return res.json({ code: 1, msg: '缺少name参数' });
        }
        const result = userDataManager.setBuffMap(id, name);
        res.json(result);
    });

    app.get('/api/enemies', (req, res) => {
        const enemiesData = userDataManager.getAllEnemiesData();
        const data = {
            code: 0,
            enemy: enemiesData,
        };
        res.json(data);
    });

    app.get('/api/clear', (req, res) => {
        userDataManager.clearAll();
        logger.info('Statistics have been cleared!');
        res.json({
            code: 0,
            msg: 'Statistics have been cleared!',
        });
    });

    // 暂停/开始统计API
    app.post('/api/pause', (req, res) => {
        const { paused } = req.body;
        isPaused = paused;
        logger.info(`Statistics ${isPaused ? 'paused' : 'resumed'}!`);
        res.json({
            code: 0,
            msg: `Statistics ${isPaused ? 'paused' : 'resumed'}!`,
            paused: isPaused,
        });
    });

    // 获取暂停状态API
    app.get('/api/pause', (req, res) => {
        res.json({
            code: 0,
            paused: isPaused,
        });
    });

    // 获取技能数据
    app.get('/api/skill/:uid', (req, res) => {
        const uid = parseInt(req.params.uid);
        const skillData = userDataManager.getUserSkillData(uid);

        if (!skillData) {
            return res.status(404).json({
                code: 1,
                msg: 'User not found',
            });
        }

        res.json({
            code: 0,
            data: skillData,
        });
    });

    // 历史数据概览
    app.get('/api/history/:timestamp/summary', async (req, res) => {
        const { timestamp } = req.params;
        const historyFilePath = path.join('./logs', timestamp, 'summary.json');

        try {
            const data = await fsPromises.readFile(historyFilePath, 'utf8');
            const summaryData = JSON.parse(data);
            res.json({
                code: 0,
                data: summaryData,
            });
        } catch (error) {
            if (error.code === 'ENOENT') {
                logger.warn('History summary file not found:', error);
                res.status(404).json({
                    code: 1,
                    msg: 'History summary file not found',
                });
            } else {
                logger.error('Failed to read history summary file:', error);
                res.status(500).json({
                    code: 1,
                    msg: 'Failed to read history summary file',
                });
            }
        }
    });

    // 历史数据
    app.get('/api/history/:timestamp/data', async (req, res) => {
        const { timestamp } = req.params;
        const historyFilePath = path.join('./logs', timestamp, 'allUserData.json');

        try {
            const data = await fsPromises.readFile(historyFilePath, 'utf8');
            const userData = JSON.parse(data);
            res.json({
                code: 0,
                user: userData,
            });
        } catch (error) {
            if (error.code === 'ENOENT') {
                logger.warn('History data file not found:', error);
                res.status(404).json({
                    code: 1,
                    msg: 'History data file not found',
                });
            } else {
                logger.error('Failed to read history data file:', error);
                res.status(500).json({
                    code: 1,
                    msg: 'Failed to read history data file',
                });
            }
        }
    });

    // 获取历史技能数据
    app.get('/api/history/:timestamp/skill/:uid', async (req, res) => {
        const { timestamp, uid } = req.params;
        const historyFilePath = path.join('./logs', timestamp, 'users', `${uid}.json`);

        try {
            const data = await fsPromises.readFile(historyFilePath, 'utf8');
            const skillData = JSON.parse(data);
            res.json({
                code: 0,
                data: skillData,
            });
        } catch (error) {
            if (error.code === 'ENOENT') {
                logger.warn('History skill file not found:', error);
                res.status(404).json({
                    code: 1,
                    msg: 'History skill file not found',
                });
            } else {
                logger.error('Failed to read history skill file:', error);
                res.status(500).json({
                    code: 1,
                    msg: 'Failed to read history skill file',
                });
            }
        }
    });

    // 下载历史战斗日志数据
    app.get('/api/history/:timestamp/download', async (req, res) => {
        const { timestamp } = req.params;
        const historyFilePath = path.join('./logs', timestamp, 'fight.log');
        const historyGzipFilePath = path.join('./logs', timestamp, 'fight.log.gz');
        try {
            await fsPromises.access(historyGzipFilePath);
            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('Content-Disposition', `attachment; filename="fight_${timestamp}.log"`);
            res.setHeader('Content-Encoding', 'gzip');

            const stream = fs.createReadStream(historyGzipFilePath);
            stream.pipe(res);
            return;
        } catch (e) {}
        res.download(historyFilePath, `fight_${timestamp}.log`);
    });

    // 历史数据列表
    app.get('/api/history/list', async (req, res) => {
        try {
            const data = (await fsPromises.readdir('./logs', { withFileTypes: true }))
                .filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
                .map((e) => e.name);
            res.json({
                code: 0,
                data: data,
            });
        } catch (error) {
            if (error.code === 'ENOENT') {
                logger.warn('History path not found:', error);
                res.status(404).json({
                    code: 1,
                    msg: 'History path not found',
                });
            } else {
                logger.error('Failed to load history path:', error);
                res.status(500).json({
                    code: 1,
                    msg: 'Failed to load history path',
                });
            }
        }
    });

    // 设置相关接口
    app.get('/api/settings', async (req, res) => {
        res.json({ code: 0, data: globalSettings });
    });

    app.post('/api/settings', async (req, res) => {
        const newSettings = req.body;
        globalSettings = { ...globalSettings, ...newSettings };
        await fsPromises.writeFile(SETTINGS_PATH, JSON.stringify(globalSettings, null, 2), 'utf8');
        res.json({ code: 0, data: globalSettings });
    });

    try {
        await fsPromises.access(SETTINGS_PATH);
        const data = await fsPromises.readFile(SETTINGS_PATH, 'utf8');
        globalSettings = { ...globalSettings, ...JSON.parse(data) };
    } catch (e) {
        if (e.code !== 'ENOENT') {
            logger.error('Failed to load settings:', e);
        }
    }

    const clearDataOnServerChange = () => {
        userDataManager.refreshEnemyCache();
        if (!globalSettings.autoClearOnServerChange || userDataManager.lastLogTime === 0 || userDataManager.users.size === 0) return;
        userDataManager.clearAll();
        logger.info('Server changed, statistics cleared!');
    };

    // WebSocket 连接处理
    io.on('connection', (socket) => {
        logger.info('WebSocket client connected: ' + socket.id);

        socket.on('disconnect', () => {
            logger.info('WebSocket client disconnected: ' + socket.id);
        });
    });

    // 每100ms广播数据给所有WebSocket客户端
    setInterval(() => {
        if (!isPaused) {
            const userData = userDataManager.getAllUsersData();
            const enemiesData = userDataManager.getAllEnemiesData();
            const buffData = userDataManager.getActiveBuffs();
            const entityUids = userDataManager.getEntityUids();
            const data = {
                code: 0,
                user: userData,
                enemy: enemiesData,
                buff: buffData,
                entityUids: entityUids,
            };
            io.emit('data', data);
        }
    }, 100);

    const checkPort = (port) => {
        return new Promise((resolve) => {
            const server = net.createServer();
            server.once('error', () => resolve(false));
            server.once('listening', () => {
                server.close(() => resolve(true));
            });
            server.listen(port);
        });
    };
    let server_port = 8989;
    while (true) {
        if (await checkPort(server_port)) break;
        logger.warn(`port ${server_port} is already in use`);
        server_port++;
    }
    server.listen(server_port, () => {
        // 自动用默认浏览器打开网页（跨平台兼容）
        const url = 'http://localhost:' + server_port;
        logger.info(`Web Server started at ${url}`);
        logger.info('WebSocket Server started');

        let command;
        switch (process.platform) {
            case 'darwin': // macOS
                command = `open ${url}`;
                break;
            case 'win32': // Windows
                command = `start ${url}`;
                break;
            default: // Linux 和其他 Unix-like 系统
                command = `xdg-open ${url}`;
                break;
        }

        exec(command, (error) => {
            if (error) {
                logger.error(`Failed to open browser: ${error.message}`);
            }
        });
    });

    logger.info('Welcome!');

    // 如果cap为null，模拟模式下不启动抓包
    if (!cap) {
        logger.info('Running in mock mode. No network capturing.');
        return;
    }

    // 检查num是否有效，避免访问undefined
    if (!num || !devices[num]) {
        logger.info('Running in mock mode. No network capturing.');
        return;
    }

    logger.info('Attempting to find the game server, please wait!');

    let current_server = '';
    let _data = Buffer.alloc(0);
    let tcp_next_seq = -1;
    let tcp_cache = new Map();
    let tcp_last_time = 0;
    const tcp_lock = new Lock();

    const clearTcpCache = () => {
        _data = Buffer.alloc(0);
        tcp_next_seq = -1;
        tcp_last_time = 0;
        tcp_cache.clear();
    };

    const fragmentIpCache = new Map();
    const FRAGMENT_TIMEOUT = 30000;
    const getTCPPacket = (frameBuffer, ethOffset) => {
        const ipPacket = decoders.IPV4(frameBuffer, ethOffset);
        const ipId = ipPacket.info.id;
        const isFragment = (ipPacket.info.flags & 0x1) !== 0;
        const _key = `${ipId}-${ipPacket.info.srcaddr}-${ipPacket.info.dstaddr}-${ipPacket.info.protocol}`;
        const now = Date.now();

        if (isFragment || ipPacket.info.fragoffset > 0) {
            if (!fragmentIpCache.has(_key)) {
                fragmentIpCache.set(_key, {
                    fragments: [],
                    timestamp: now,
                });
            }

            const cacheEntry = fragmentIpCache.get(_key);
            const ipBuffer = Buffer.from(frameBuffer.subarray(ethOffset));
            cacheEntry.fragments.push(ipBuffer);
            cacheEntry.timestamp = now;

            // there's more fragment ip packetm, wait for the rest
            if (isFragment) {
                return null;
            }

            // last fragment received, reassemble
            const fragments = cacheEntry.fragments;
            if (!fragments) {
                logger.error(`Can't find fragments for ${_key}`);
                return null;
            }

            // Reassemble fragments based on their offset
            let totalLength = 0;
            const fragmentData = [];

            // Collect fragment data with their offsets
            for (const buffer of fragments) {
                const ip = decoders.IPV4(buffer);
                const fragmentOffset = ip.info.fragoffset * 8;
                const payloadLength = ip.info.totallen - ip.hdrlen;
                const payload = Buffer.from(buffer.subarray(ip.offset, ip.offset + payloadLength));

                fragmentData.push({
                    offset: fragmentOffset,
                    payload: payload,
                });

                const endOffset = fragmentOffset + payloadLength;
                if (endOffset > totalLength) {
                    totalLength = endOffset;
                }
            }

            const fullPayload = Buffer.alloc(totalLength);
            for (const fragment of fragmentData) {
                fragment.payload.copy(fullPayload, fragment.offset);
            }

            fragmentIpCache.delete(_key);
            return fullPayload;
        }

        return Buffer.from(frameBuffer.subarray(ipPacket.offset, ipPacket.offset + (ipPacket.info.totallen - ipPacket.hdrlen)));
    };

    //抓包相关
    const eth_queue = [];
    const c = new Cap();
    const device = devices[num].name;
    const filter = 'ip and tcp';
    const bufSize = 10 * 1024 * 1024;
    const buffer = Buffer.alloc(65535);
    const linkType = c.open(device, filter, bufSize, buffer);
    const supportedLinkType = ['ETHERNET', 'NULL', 'LINKTYPE_LINUX_SLL'];
    if (!supportedLinkType.includes(linkType)) {
        logger.error('The device seems to be WRONG! Please check the device! Device type: ' + linkType);
    }

    // 确保PROTOCOL变量已初始化
    if (!PROTOCOL || !PROTOCOL.ETHERNET) {
        logger.error('PROTOCOL variables not properly initialized. Starting in mock mode.');
        return;
    }

    c.setMinBytes && c.setMinBytes(0);
    c.on('packet', async function (nbytes, trunc) {
        eth_queue.push(Buffer.from(buffer.subarray(0, nbytes)));
    });
    const processEthPacket = async (frameBuffer) => {
        // logger.debug('packet: length ' + nbytes + ' bytes, truncated? ' + (trunc ? 'yes' : 'no'));

        let ethPacket;
        if (linkType === 'ETHERNET') {
            ethPacket = decoders.Ethernet(frameBuffer);
        } else if (linkType === 'NULL') {
            ethPacket = {
                info: {
                    dstmac: '44:69:6d:6f:6c:65',
                    srcmac: '44:69:6d:6f:6c:65',
                    type: frameBuffer.readUInt32LE() === 2 ? 2048 : 75219598273637n,
                    vlan: undefined,
                    length: undefined,
                },
                offset: 4,
            };
        } else if (linkType === 'LINKTYPE_LINUX_SLL') {
            ethPacket = {
                info: {
                    dstmac: '44:69:6d:6f:6c:65',
                    srcmac: '44:69:6d:6f:6c:65',
                    type: frameBuffer.readUInt32BE(14) === 0x0800 ? 2048 : 75219598273637n,
                    vlan: undefined,
                    length: undefined,
                },
                offset: 16,
            };
        }

        if (ethPacket.info.type !== PROTOCOL.ETHERNET.IPV4) return;

        const ipPacket = decoders.IPV4(frameBuffer, ethPacket.offset);
        const srcaddr = ipPacket.info.srcaddr;
        const dstaddr = ipPacket.info.dstaddr;

        const tcpBuffer = getTCPPacket(frameBuffer, ethPacket.offset);
        if (tcpBuffer === null) return;
        const tcpPacket = decoders.TCP(tcpBuffer);

        const buf = Buffer.from(tcpBuffer.subarray(tcpPacket.hdrlen));

        //logger.debug(' from port: ' + tcpPacket.info.srcport + ' to port: ' + tcpPacket.info.dstport);
        const srcport = tcpPacket.info.srcport;
        const dstport = tcpPacket.info.dstport;
        const src_server = srcaddr + ':' + srcport + ' -> ' + dstaddr + ':' + dstport;
        const src_server_re = dstaddr + ':' + dstport + ' -> ' + srcaddr + ':' + srcport;

        await tcp_lock.acquire();
        if (current_server !== src_server && current_server !== src_server_re) {
            try {
                //尝试通过小包识别服务器
                if (buf[4] == 0 && buf[5] == 6) {
                    const data = buf.subarray(10);
                    if (data.length) {
                        const stream = Readable.from(data, { objectMode: false });
                        let data1;
                        do {
                            const len_buf = stream.read(4);
                            if (!len_buf) break;
                            data1 = stream.read(len_buf.readUInt32BE() - 4);
                            const signature = Buffer.from([0x00, 0x63, 0x33, 0x53, 0x42, 0x00]); //c3SB??
                            if (Buffer.compare(data1.subarray(5, 5 + signature.length), signature)) break;
                            try {
                                if (current_server !== src_server) {
                                    current_server = src_server;
                                    clearTcpCache();
                                    tcp_next_seq = tcpPacket.info.seqno + buf.length;
                                    clearDataOnServerChange();
                                    logger.info('Got Scene Server Address by FrameDown Notify Packet: ' + src_server);
                                }
                            } catch (e) {}
                        } while (data1 && data1.length);
                    }
                }
            } catch (e) {}
            try {
                //尝试通过登录返回包识别服务器(仍需测试)
                if (buf.length === 0x62) {
                    // prettier-ignore
                    const signature = Buffer.from([
                        0x00, 0x00, 0x00, 0x62,
                        0x00, 0x03,
                        0x00, 0x00, 0x00, 0x01,
                        0x00, 0x11, 0x45, 0x14,//seq?
                        0x00, 0x00, 0x00, 0x00,
                        0x0a, 0x4e, 0x08, 0x01, 0x22, 0x24
                    ]);
                    if (
                        Buffer.compare(buf.subarray(0, 10), signature.subarray(0, 10)) === 0 &&
                        Buffer.compare(buf.subarray(14, 14 + 6), signature.subarray(14, 14 + 6)) === 0
                    ) {
                        if (current_server !== src_server) {
                            current_server = src_server;
                            clearTcpCache();
                            tcp_next_seq = tcpPacket.info.seqno + buf.length;
                            clearDataOnServerChange();
                            logger.info('Got Scene Server Address by Login Return Packet: ' + src_server);
                        }
                    }
                }
            } catch (e) {}
            try {
                //尝试通过一个上报的小包识别服务器
                if (buf[4] == 0 && buf[5] == 5) {
                    const data = buf.subarray(10);
                    if (data.length) {
                        const stream = Readable.from(data, { objectMode: false });
                        let data1;
                        do {
                            const len_buf = stream.read(4);
                            if (!len_buf) break;
                            data1 = stream.read(len_buf.readUInt32BE() - 4);
                            const signature = Buffer.from([0x00, 0x06, 0x26, 0xad, 0x66, 0x00]);
                            if (Buffer.compare(data1.subarray(5, 5 + signature.length), signature)) break;
                            try {
                                if (current_server !== src_server_re) {
                                    current_server = src_server_re;
                                    clearTcpCache();
                                    tcp_next_seq = tcpPacket.info.ackno;
                                    clearDataOnServerChange();
                                    logger.info('Got Scene Server Address by FrameUp Notify Packet: ' + src_server_re);
                                }
                            } catch (e) {}
                        } while (data1 && data1.length);
                    }
                }
            } catch (e) {}
            tcp_lock.release();
            return;
        }
        // logger.debug(`packet seq ${tcpPacket.info.seqno >>> 0} size ${buf.length} expected next seq ${((tcpPacket.info.seqno >>> 0) + buf.length) >>> 0}`);
        //这里已经是识别到的服务器的包了
        if (tcp_next_seq === -1) {
            logger.error('Unexpected TCP capture error! tcp_next_seq is -1');
            if (buf.length > 4 && buf.readUInt32BE() < 0x0fffff) {
                tcp_next_seq = tcpPacket.info.seqno;
            }
        }
        // logger.debug('TCP next seq: ' + tcp_next_seq);
        if ((tcp_next_seq - tcpPacket.info.seqno) << 0 <= 0 || tcp_next_seq === -1) {
            tcp_cache.set(tcpPacket.info.seqno, buf);
        }
        while (tcp_cache.has(tcp_next_seq)) {
            const seq = tcp_next_seq;
            const cachedTcpData = tcp_cache.get(seq);
            _data = _data.length === 0 ? cachedTcpData : Buffer.concat([_data, cachedTcpData]);
            tcp_next_seq = (seq + cachedTcpData.length) >>> 0; //uint32
            tcp_cache.delete(seq);
            tcp_last_time = Date.now();
        }

        while (_data.length > 4) {
            let packetSize = _data.readUInt32BE();

            if (_data.length < packetSize) break;

            if (_data.length >= packetSize) {
                const packet = _data.subarray(0, packetSize);
                _data = _data.subarray(packetSize);
                const processor = new PacketProcessor({ logger, userDataManager });
                processor.processPacket(packet);
            } else if (packetSize > 0x0fffff) {
                logger.error(`Invalid Length!! ${_data.length},${len},${_data.toString('hex')},${tcp_next_seq}`);
                process.exit(1);
                break;
            }
        }
        tcp_lock.release();
    };
    (async () => {
        while (true) {
            if (eth_queue.length) {
                const pkt = eth_queue.shift();
                processEthPacket(pkt);
            } else {
                await new Promise((r) => setTimeout(r, 1));
            }
        }
    })();

    //定时清理过期的IP分片缓存
    setInterval(async () => {
        const now = Date.now();
        let clearedFragments = 0;
        for (const [key, cacheEntry] of fragmentIpCache) {
            if (now - cacheEntry.timestamp > FRAGMENT_TIMEOUT) {
                fragmentIpCache.delete(key);
                clearedFragments++;
            }
        }
        if (clearedFragments > 0) {
            logger.debug(`Cleared ${clearedFragments} expired IP fragment caches`);
        }

        if (tcp_last_time && Date.now() - tcp_last_time > FRAGMENT_TIMEOUT) {
            logger.warn('Cannot capture the next packet! Is the game closed or disconnected? seq: ' + tcp_next_seq);
            current_server = '';
            clearTcpCache();
        }
    }, 10000);
}

if (!zlib.zstdDecompressSync) {
    // 之前总是有人用旧版本nodejs，不看警告还说数据不准，现在干脆不让旧版用算了
    // 还有人对着开源代码写闭源，不遵守许可就算了，还要诋毁开源，什么人啊这是
    warnAndExit('zstdDecompressSync is not available! Please update your Node.js!');
}

main();
