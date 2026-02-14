const fs = require('fs');
const path = require('path');

const buffTablePath = path.join(__dirname, '../tables/BuffTable.json');
const buffMapPath = path.join(__dirname, '../tables/buff_map.json');

try {
    const buffTable = JSON.parse(fs.readFileSync(buffTablePath, 'utf-8'));
    const existingBuffMap = JSON.parse(fs.readFileSync(buffMapPath, 'utf-8'));
    
    const newBuffMap = {};
    
    for (const [key, buffData] of Object.entries(buffTable)) {
        const id = String(buffData.Id);
        const name = buffData.NameDesign || buffData.Name || '(未命名)';
        
        if (existingBuffMap[id]) {
            newBuffMap[id] = existingBuffMap[id];
        } else {
            const isDebuff = name.includes('虚弱');
            newBuffMap[id] = { name, isDebuff };
        }
    }
    
    for (const [id, info] of Object.entries(existingBuffMap)) {
        if (!newBuffMap[id]) {
            newBuffMap[id] = info;
        }
    }
    
    const sortedBuffMap = {};
    const sortedKeys = Object.keys(newBuffMap).sort((a, b) => parseInt(a) - parseInt(b));
    for (const key of sortedKeys) {
        sortedBuffMap[key] = newBuffMap[key];
    }
    
    fs.writeFileSync(buffMapPath, JSON.stringify(sortedBuffMap, null, 2), 'utf-8');
    console.log(`Successfully imported ${Object.keys(sortedBuffMap).length} buffs to buff_map.json`);
} catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
}
