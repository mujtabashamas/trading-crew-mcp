# trading-crew-mcp

An MCP server that lets Claude read and annotate the chart open in a **locally running TradingView Desktop** app: read price and candles, draw lines, manage price alerts. Written from scratch (original code, MIT).

## Tools (13)
| Group | Tools |
|---|---|
| Read | `chart_health`, `get_quote`, `get_candles` |
| View | `set_timeframe`, `set_visible_range` |
| Draw | `list_drawings`, `draw_trend_line`, `draw_horizontal_line`, `remove_drawing`, `clear_drawings` |
| Alerts | `list_alerts`, `create_alert`, `delete_alert` |

Safety by design:
- There is **no** tool that clicks the UI, types, or runs arbitrary page code, so the server cannot reach the order panel or place a trade.
- `create_alert` refuses a level on the wrong side of live price (it would fire at once), then reads the alert back and fails if the stored level differs.
- `delete_alert` confirms the alert is gone.

## How it works
TradingView Desktop is started with Chromium's standard debug port. The server connects to that port on `localhost` and runs small functions in the open chart page: it reads candles and draws through the page's own chart object (`window.TradingViewApi`). For alerts it makes the same requests to TradingView's alert service that the page itself makes, using your already signed-in session, so it does talk to TradingView's servers on your behalf. It does not bypass any login, subscription or access control.

## Install
```
npm install
```
Start TradingView with its debug port (macOS example):
```
open -a TradingView --args --remote-debugging-port=9222
```
Add to Claude Code:
```
claude mcp add trading-crew --scope project -- node /full/path/to/trading-crew-mcp/src/server.js
```
Environment: `TV_DEBUG_HOST` (default `127.0.0.1`), `TV_DEBUG_PORT` (default `9222`).

Check it against your chart: `node scripts/smoke.mjs` (draws two lines and removes them, creates a test alert far from price and deletes it).

## Status
Version 0.1. Works on TradingView Desktop (macOS) with the page version of 12 Nov 2026. TradingView can change its internals at any time, which would break the page calls; the alert payload in particular was matched to a real request and may need updating.

## Disclaimer
Personal and educational use. Not affiliated with, endorsed by, or associated with TradingView Inc. TradingView's Terms of Use restrict automated access to their platform, and this tool drives the desktop app programmatically, which may conflict with those terms. You are responsible for your own use and accept the risk, including account restrictions. Do not use it to resell market data or for automated trading. Nothing here is financial advice.
