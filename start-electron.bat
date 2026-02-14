@echo off
chcp 65001 >nul
echo Starting Star Resonance Damage Counter (Electron)...
echo.
pnpm install
npx electron .
pause
