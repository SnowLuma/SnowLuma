node .\check-node-version.cjs
if errorlevel 1 (
  pause
  exit /b 1
)
node ./index.mjs
pause
