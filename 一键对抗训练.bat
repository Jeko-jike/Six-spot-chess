@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title SixGo - Adversarial Training

rem ============================================================
rem EDITABLE SETTINGS
rem Change numbers on the right side only.
rem Keep the variable name, equal sign, and quotation marks.
rem Full Chinese explanations are in adversarial training guide MD.
rem ============================================================

rem Extra rounds for EACH game in this run.
rem Example: 10 means add 10 new rounds to existing progress.
set "ROUNDS=16"

rem Gomoku self-play games generated in each round.
rem Larger = slower, but produces more training data.
set "GOMOKU_SELF_GAMES=800"

rem Connect6 self-play games generated in each round.
rem Connect6 is normally slower because it has more branches.
set "CONNECT6_SELF_GAMES=720"

rem Challenger-versus-champion games in each round.
rem Keep this EVEN so both models play Black equally often.
rem 80 is normal; 200 or 400 gives a more reliable test.
set "ARENA_GAMES=80"

rem Maximum replay samples kept for EACH game.
rem Larger = more disk space and longer replay training.
set "REPLAY_POSITIONS=250000"

rem Number of passes over the replay pool per round.
rem Larger = slower and may overfit if set too high.
set "EPOCHS=3"

rem Neural-network hidden units.
rem 32 is lightweight. You may try 48 or 64 for more capacity.
set "HIDDEN_UNITS=32"

rem Promotion score. 0.53 means 53 percent; draws count as 0.5.
rem Recommended range: 0.52 to 0.58.
set "PROMOTE_SCORE=0.53"

rem ============================================================
rem END OF EDITABLE SETTINGS. Usually do not edit below this line.
rem ============================================================

where node.exe >nul 2>nul
if errorlevel 1 goto node_missing
if "%SIXGO_VALIDATE_ONLY%"=="1" goto validate_ok

echo ============================================================
echo SixGo lightweight adversarial training
echo ============================================================
echo Extra rounds per game : %ROUNDS%
echo Gomoku games/round    : %GOMOKU_SELF_GAMES%
echo Connect6 games/round  : %CONNECT6_SELF_GAMES%
echo Arena games/round     : %ARENA_GAMES%
echo Replay limit/game     : %REPLAY_POSITIONS%
echo Replay epochs         : %EPOCHS%
echo Hidden units          : %HIDDEN_UNITS%
echo Promotion score       : %PROMOTE_SCORE%
echo ------------------------------------------------------------
echo A checkpoint is saved after every completed round.
echo The trainer shows current-run progress and total history.
echo ============================================================
echo.

echo [STAGE 1/4] Train 13x13 Gomoku - add %ROUNDS% rounds
node.exe adversarial-train.js --size 13 --win 5 --rounds %ROUNDS% --self-games %GOMOKU_SELF_GAMES% --arena-games %ARENA_GAMES% --replay %REPLAY_POSITIONS% --epochs %EPOCHS% --hidden %HIDDEN_UNITS% --promote %PROMOTE_SCORE%
if errorlevel 1 goto failed

echo.
echo [STAGE 2/4] Import Gomoku champion into HTML
node.exe import-ai-weights.js trained-weights-13x13-win5.json
if errorlevel 1 goto failed

echo.
echo [STAGE 3/4] Train 19x19 Connect6 - add %ROUNDS% rounds
node.exe adversarial-train.js --size 19 --win 6 --rounds %ROUNDS% --self-games %CONNECT6_SELF_GAMES% --arena-games %ARENA_GAMES% --replay %REPLAY_POSITIONS% --epochs %EPOCHS% --hidden %HIDDEN_UNITS% --promote %PROMOTE_SCORE%
if errorlevel 1 goto failed

echo.
echo [STAGE 4/4] Import Connect6 champion into HTML
node.exe import-ai-weights.js trained-weights-19x19-win6.json
if errorlevel 1 goto failed

echo.
echo ============================================================
echo SUCCESS: both champion models were imported into:
echo   six_go.html
echo   index.html
echo Push the latest index.html when using GitHub Pages.
echo ============================================================
pause
exit /b 0

:node_missing
echo.
echo ERROR: Node.js was not found in PATH.
echo Install Node.js and then run this BAT again.
echo https://nodejs.org/
pause
exit /b 1

:validate_ok
echo BAT_PARSE_OK ROUNDS=%ROUNDS% CONNECT6=%CONNECT6_SELF_GAMES% REPLAY=%REPLAY_POSITIONS%
exit /b 0

:failed
echo.
echo ============================================================
echo ERROR: training or model import failed.
echo Completed rounds, replay pools, and champions are preserved.
echo Read the error message above this box.
echo ============================================================
pause
exit /b 1
