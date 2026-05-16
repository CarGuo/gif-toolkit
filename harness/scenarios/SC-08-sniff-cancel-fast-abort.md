# SC-08 — sniff:cancel must abort within 1s

## 输入
- 在 sniffPage 启动后 50–200 ms 内调用 `ipcMain` 的 `sniff:cancel`(或直接给 `sniffPage` 传一个 `signal` 然后 abort)。

## 期望
- sniffPage 抛出可识别的取消错误(`name === 'CancelledError'` 或 axios `CanceledError`)。
- 报错时间 ≤ 1 秒。
- 没有遗留的 axios 流 / headless BrowserWindow / Node 子进程在后台继续跑。

## 验证脚本
```bash
./node_modules/.bin/electron /tmp/giftk-sniff-cancel-e2e.js
# 预期:
# SNIFF_CANCEL_PROBE name=CancelledError|CanceledError msg=...
# SNIFF_CANCEL_RESULT <1000ms cancelled=true
```

## 关联代码
- [sniff:cancel handler](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts)
- [sniffPage signal](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/sniffer.ts)
- [fetchHtmlStreamed signal bridge](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/sniffer.ts)

## 反例
- ❌ `signal?` 只在入口 check,不传给 axios — 流仍然在 5MB 上限内继续累加。
- ❌ AbortController 不绑定到外部 signal — 调用方 abort 不传播。
