# trading-crew-mcp

An MCP server that lets Claude read and annotate a chart in a **locally running TradingView Desktop** app: read price and candles, draw lines, manage price alerts. Written from scratch (work in progress).

## Status
Early. Nothing here is finished. See the roadmap below.

## How it works
TradingView Desktop is started with Chromium's standard debug port. The server connects to that port on `localhost` and calls functions on the chart page that is already open. It does not contact TradingView's servers and does not bypass any login or subscription.

## Roadmap
- [ ] Connection and health check
- [ ] Read: quote, candles, chart state
- [ ] Draw: trend lines, horizontal lines, clear
- [ ] Alerts: list, create (with a check that the stored value matches), delete
- [ ] Safety: no tools that click the order panel or run arbitrary page code

## Disclaimer
Personal and educational use. This project is not affiliated with, endorsed by, or associated with TradingView Inc. TradingView's Terms of Use restrict automated access to their platform, and this tool drives the desktop app programmatically, which may conflict with those terms. You are responsible for your own use and accept the risk, including account restrictions. It must not be used to resell market data or for automated trading. Nothing here is financial advice.
