#!/bin/sh
set -eu

APP_NAME_VALUE=${APP_NAME:-TRACKY}
APP_DESC_VALUE=${APP_DESC:-Department Time Tracking Control Panel}
TAB_TITLE_VALUE=${TAB_TITLE:-Tracky}
API_BASE_VALUE=${API_BASE:-}

{
  printf 'window.TRACKY_CONFIG = '
  jq -n \
    --arg APP_NAME "$APP_NAME_VALUE" \
    --arg APP_DESC "$APP_DESC_VALUE" \
    --arg TAB_TITLE "$TAB_TITLE_VALUE" \
    --arg API_BASE "$API_BASE_VALUE" \
    '{
      APP_NAME: $APP_NAME,
      APP_DESC: $APP_DESC,
      TAB_TITLE: $TAB_TITLE,
      API_BASE: $API_BASE
    }'
  printf ';\n'
} > /usr/share/nginx/html/config.js
