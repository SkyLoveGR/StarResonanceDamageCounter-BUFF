'use strict';
const fs = require('fs');
const path = require('path');

// 判断是否在pkg打包环境中运行
const isPkg = process.pkg !== undefined;
const basePath = isPkg ? path.dirname(process.execPath) : path.join(__dirname, '..');

const BUFF_MAP_PATH = isPkg ? path.join(basePath, 'tables/buff_map.json') : path.join(__dirname, '../tables/buff_map.json');
const STACK_BUFF_MAP_PATH = isPkg ? path.join(basePath, 'tables/stack_buff_map.json') : path.join(__dirname, '../tables/stack_buff_map.json');
const BUFF_SEEN_PATH = isPkg ? path.join(basePath, 'data/buff_seen.json') : path.join(__dirname, '../data/buff_seen.json');
const STATE_PATH = isPkg ? path.join(basePath, 'data/state.json') : path.join(__dirname, '../data/state.json');
const BUFF_CONFIG_PATH = isPkg ? path.join(basePath, 'data/buff_config.json') : path.join(__dirname, '../data/buff_config.json');

function loadJson(p, def = {}) {
    try {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
        return def;
    }
}

function saveJson(p, obj) {
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
}

class StateWriter {
    constructor({ outPath = './state.json' } = {}) {
        this.state = Object.create(null);
        this.outPath = outPath;
    }

    setOne(id, v) {
        const s = this.state[id] || (this.state[id] = {});
        if ('durUntil' in v) s.durUntil = v.durUntil ?? 0;
        if ('cdUntil' in v) s.cdUntil = v.cdUntil ?? 0;
        if ('stack' in v) s.stack = v.stack ?? 0;
        if ('durationMs' in v) s.durationMs = v.durationMs ?? 0;
        if ('startTime' in v) s.startTime = v.startTime ?? 0;
    }

    resetAll() {
        for (const k of Object.keys(this.state)) delete this.state[k];
        fs.writeFileSync(this.outPath, '{}', 'utf8');
    }

    flush() {
        const now = Date.now();

        for (const [id, v] of Object.entries(this.state)) {
            if (!v || typeof v !== 'object') {
                delete this.state[id];
                continue;
            }

            const durUntil = v.durUntil ?? 0;
            const cdUntil = v.cdUntil ?? 0;

            const durDead = durUntil > 0 && durUntil <= now;
            const cdAlive = cdUntil > now;

            if (durDead && !cdAlive) delete this.state[id];
        }

        fs.writeFileSync(this.outPath, JSON.stringify(this.state, null, 2), 'utf8');
    }

    delOne(id) {
        if (id in this.state) delete this.state[id];
    }
}

class BuffMonitor {
    constructor(logger) {
        this.logger = logger;
        this.buffMap = loadJson(BUFF_MAP_PATH, {});
        this.stackBuffMap = loadJson(STACK_BUFF_MAP_PATH, {});
        this.buffSeen = loadJson(BUFF_SEEN_PATH, {});
        this.buffConfig = this.loadBuffConfig();
        this.activeBuffsByEntity = new Map();
        this.slotLastBuffId = new Map();
        this.slotToEntity = new Map();
        this.overlayDirty = false;

        const dataDir = path.join(__dirname, '../data');
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }

        this.overlayWriter = new StateWriter({ outPath: STATE_PATH });

        setInterval(() => {
            if (this.overlayDirty) {
                this.overlayWriter.flush();
                this.overlayDirty = false;
            }
            this.saveBuffSeen();
        }, 80);
    }

    loadBuffConfig() {
        const config = loadJson(BUFF_CONFIG_PATH, { enabledBuffs: [], showUnmapped: true });
        return {
            enabledBuffs: new Set(config.enabledBuffs || []),
            showUnmapped: config.showUnmapped !== false,
        };
    }

    saveBuffConfig() {
        const config = {
            enabledBuffs: Array.from(this.buffConfig.enabledBuffs),
            showUnmapped: this.buffConfig.showUnmapped,
        };
        saveJson(BUFF_CONFIG_PATH, config);
    }

    setBuffEnabled(buffId, enabled) {
        if (enabled) {
            this.buffConfig.enabledBuffs.add(buffId);
        } else {
            this.buffConfig.enabledBuffs.delete(buffId);
        }
        this.saveBuffConfig();
    }

    setShowUnmapped(show) {
        this.buffConfig.showUnmapped = show;
        this.saveBuffConfig();
    }

    selectAllBuffs(enabled) {
        if (enabled) {
            for (const [id, name] of Object.entries(this.buffMap)) {
                this.buffConfig.enabledBuffs.add(id);
            }
            for (const [id, info] of Object.entries(this.buffSeen)) {
                this.buffConfig.enabledBuffs.add(id);
            }
        } else {
            this.buffConfig.enabledBuffs.clear();
        }
        this.saveBuffConfig();
    }

    isBuffEnabled(buffId, name) {
        if (name === '(未映射)' && !this.buffConfig.showUnmapped) {
            return false;
        }
        if (this.buffConfig.enabledBuffs.size === 0) {
            return true;
        }
        return this.buffConfig.enabledBuffs.has(buffId);
    }

    searchBuffs(keyword) {
        const results = [];
        const lowerKeyword = keyword.toLowerCase();

        for (const [id, name] of Object.entries(this.buffMap)) {
            if (id.includes(keyword) || name.toLowerCase().includes(lowerKeyword)) {
                results.push({ id, name, enabled: this.buffConfig.enabledBuffs.has(id), mapped: true });
            }
        }

        for (const [id, info] of Object.entries(this.buffSeen)) {
            if (!this.buffMap[id]) {
                if (id.includes(keyword)) {
                    results.push({ id, name: '(未映射)', enabled: this.buffConfig.enabledBuffs.has(id), mapped: false });
                }
            }
        }

        return results.sort((a, b) => {
            if (a.mapped !== b.mapped) {
                return a.mapped ? -1 : 1;
            }
            return parseInt(a.id) - parseInt(b.id);
        });
    }

    onBuffEvent(ev, meta) {
        const entityUid = meta?.entityUid;

        if (ev.opType === 2) {
            const lastId = this.slotLastBuffId.get(ev.slot);
            const trustedId = ev.buffId && ev.buffId !== 1 ? ev.buffId : lastId;

            if (!trustedId) return;

            const idStr = String(trustedId);
            const name = this.buffMap[idStr] ?? '(未映射)';
            this.logger.info(`[BUFF-] uid=${entityUid} buffId=${idStr} name=${name} slot=${ev.slot} op=${ev.opType}`);

            const entityUidFromSlot = this.slotToEntity.get(ev.slot);
            const targetEntityUid = entityUid || entityUidFromSlot;

            if (targetEntityUid) {
                const entityBuffs = this.activeBuffsByEntity.get(targetEntityUid);
                if (entityBuffs) {
                    const slots = entityBuffs.get(idStr);
                    if (slots) {
                        slots.delete(ev.slot);
                        if (slots.size === 0) {
                            entityBuffs.delete(idStr);
                        }
                    }
                }
            }

            this.slotLastBuffId.delete(ev.slot);
            this.slotToEntity.delete(ev.slot);
            return;
        }

        if (ev.opType === 1 && ev.buffId && ev.buffId !== 1) {
            const idStr = String(ev.buffId);
            this.slotLastBuffId.set(ev.slot, ev.buffId);
            if (entityUid) {
                this.slotToEntity.set(ev.slot, entityUid);
            }

            if (!this.buffSeen[idStr]) {
                this.buffSeen[idStr] = { firstSeen: Date.now(), count: 0 };
            }
            this.buffSeen[idStr].count++;

            const name = this.buffMap[idStr] ?? '(未映射)';

            const key = `${entityUid}:${idStr}`;
            const s = global.__BUFF_STATE_MAP__?.get(key);
            if (s) {
                if (s.layer != null) ev.layer = s.layer;
                if (s.durationMs != null) ev.durationMs = s.durationMs;
            }

            const durationMs = ev.durationMs ?? 0;
            const durationSec = durationMs / 1000;

            if (durationMs <= 0) {
                this.logger.debug(`[BUFF] Skipping buff ${idStr} with duration ${durationSec.toFixed(1)}s (no duration or <=0s)`);
                return;
            }

            const durUntil = durationMs > 0 ? Date.now() + durationMs : 0;
            const startTime = Date.now();

            this.logger.info(
                `[BUFF+] uid=${entityUid} buffId=${idStr} name=${name} slot=${ev.slot} dur=${durationSec.toFixed(1)}s durUntil=${durUntil} stack=${ev.layer ?? ev.stack ?? 1} op=${ev.opType}`,
            );

            if (!entityUid) return;

            let entityBuffs = this.activeBuffsByEntity.get(entityUid);
            if (!entityBuffs) {
                entityBuffs = new Map();
                this.activeBuffsByEntity.set(entityUid, entityBuffs);
            }

            let slots = entityBuffs.get(idStr);
            if (!slots) {
                slots = new Map();
                entityBuffs.set(idStr, slots);
            }

            const stack = ev.layer ?? ev.stack ?? 1;

            slots.set(ev.slot, {
                durUntil,
                cdUntil: 0,
                stack,
                durationMs,
                startTime,
            });

            this.overlayWriter.setOne(idStr, {
                durUntil,
                cdUntil: 0,
                stack,
                durationMs,
                startTime,
            });
            this.overlayDirty = true;
        }
    }

    aggSlots(slots) {
        let durUntil = 0,
            cdUntil = 0,
            maxStack = 0,
            maxDurationMs = 0,
            earliestStart = Infinity;
        for (const s of slots.values()) {
            if ((s.durUntil ?? 0) > durUntil) durUntil = s.durUntil;
            if ((s.cdUntil ?? 0) > cdUntil) cdUntil = s.cdUntil;
            if ((s.stack ?? 0) > maxStack) maxStack = s.stack;
            if ((s.durationMs ?? 0) > maxDurationMs) maxDurationMs = s.durationMs;
            if ((s.startTime ?? Infinity) < earliestStart) earliestStart = s.startTime;
        }
        return { durUntil, cdUntil, stack: maxStack, durationMs: maxDurationMs, startTime: earliestStart };
    }

    getActiveBuffs(filterEntityUid = null) {
        const result = {};
        const now = Date.now();

        for (const [entityUid, entityBuffs] of this.activeBuffsByEntity.entries()) {
            if (filterEntityUid !== null && entityUid !== filterEntityUid) {
                continue;
            }

            const entityResult = {};
            const buffsToDelete = [];

            for (const [buffId, slots] of entityBuffs.entries()) {
                const aggData = this.aggSlots(slots);
                const name = this.buffMap[buffId] ?? '(未映射)';

                if (!this.isBuffEnabled(buffId, name)) {
                    continue;
                }

                const remainingMs = Math.max(0, aggData.durUntil - now);

                // 如果buff已过期，标记删除
                if (remainingMs <= 0) {
                    buffsToDelete.push(buffId);
                    continue;
                }

                // 从全局状态获取最新的层数
                const key = `${entityUid}:${buffId}`;
                const globalState = global.__BUFF_STATE_MAP__?.get(key);
                const currentStack = globalState?.layer ?? aggData.stack;

                const totalDurationMs = aggData.durationMs || 0;
                const progress = totalDurationMs > 0 ? remainingMs / totalDurationMs : 0;

                entityResult[buffId] = {
                    name,
                    durUntil: aggData.durUntil,
                    stack: currentStack,
                    count: slots.size,
                    remainingSec: (remainingMs / 1000).toFixed(1),
                    totalDurationSec: (totalDurationMs / 1000).toFixed(1),
                    progress: progress.toFixed(2),
                };
            }

            // 删除已过期的buff
            for (const buffId of buffsToDelete) {
                entityBuffs.delete(buffId);
                this.logger.debug(`[BUFF] Auto removed expired buff ${buffId} for entity ${entityUid}`);
            }

            // 如果该角色没有buff了，删除整个角色
            if (entityBuffs.size === 0) {
                this.activeBuffsByEntity.delete(entityUid);
            } else if (Object.keys(entityResult).length > 0) {
                result[entityUid] = entityResult;
            }
        }
        return result;
    }

    getEntityUids() {
        return Array.from(this.activeBuffsByEntity.keys());
    }

    saveBuffSeen() {
        saveJson(BUFF_SEEN_PATH, this.buffSeen);
    }

    saveBuffMap() {
        saveJson(BUFF_MAP_PATH, this.buffMap);
    }

    resetAllState() {
        this.activeBuffsByEntity.clear();
        this.slotLastBuffId.clear();
        this.slotToEntity.clear();
        this.overlayDirty = false;
        try {
            this.overlayWriter.resetAll();
        } catch (e) {
            this.logger.error('[resetAllState] writer.resetAll failed:', e?.message || e);
        }
    }
}

module.exports = BuffMonitor;
