@echo off
node -e "
const { spawn } = require('child_process');
const proc = spawn('node', ['server.js'], { stdio: 'pipe' });

proc.stdout.on('data', (data) => {
    console.log(data.toString());
});

proc.stderr.on('data', (data) => {
    console.error(data.toString());
});

proc.on('close', (code) => {
    console.log(`Process exited with code ${code}`);
});

// 等待提示输入网络设备
setTimeout(() => {
    proc.stdin.write('9\n');
    console.log('Selected network device 9');
    
    // 等待提示输入日志级别
    setTimeout(() => {
        proc.stdin.write('info\n');
        console.log('Set log level to info');
    }, 1000);
}, 2000);
"
pause