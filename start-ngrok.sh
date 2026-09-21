#!/bin/sh
cd "$(dirname "$0")" || exit 1
PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
export PATH
port=$(node --input-type=module -e 'import {loadEnvironment,getConfig} from "./src/config.js"; loadEnvironment(); console.log(getConfig().port)') || exit 1
ngrok http "http://127.0.0.1:$port"
printf '\nngrok 已停止；按回车退出……'
IFS= read -r answer
