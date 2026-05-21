# SC-01 — dedup-key 必须通用,不为某个 host 写死

> **来源**:第 12 轮用户反馈"我想知道这个 URL 为什么会嗅探出 6 个 gif"+ 第 14/15 轮 "我要的是通用实现"。
> **关联规则**:[R-02](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-02-no-host-whitelist.md)

---

## 触发条件

页面里同一资源被服务器以**不同展示参数**(尺寸 hint / 质量 hint / 缩略后缀)对外发布多次,例如:

```
https://cdn.example.com/foo.gif=s400
https://cdn.example.com/foo.gif=s640
https://cdn.example.com/foo.gif?w=400&q=70
https://cdn.example.com/foo_thumb.gif
```

或者 google-hosted blogger 资源:

```
https://blogger.googleusercontent.com/img/.../=s320
https://blogger.googleusercontent.com/img/.../=s640
https://blogger.googleusercontent.com/img/.../=s1280
```

或者 CDN 把展示变体编码进路径段(尺寸 / 格式 / 质量 / 裁剪),True Chrome 嗅探会同时捕获 `img.currentSrc` 和网络请求:

```
https://cdn.example.com/v2/resize:fit:1400/format:webp/asset.gif
https://cdn.example.com/v2/resize:fit:1440/asset.gif
https://cdn.example.com/v2/quality:80/asset.gif
```

---

## 期望行为

- 这 4 个(或 3 个)URL 在嗅探结果里**应当合并为 1 条** SniffedMedia
- 静态 HTML 嗅探 / WebView 嗅探 / True Chrome 嗅探必须共用同一套 canonical dedup 规则
- dedup 命中后保留 variantScore 更高的 URL(更大尺寸 / 更少格式转码 / 已有响应元数据);**id 保持稳定**(避免 renderer 中已经选中的项被刷新掉)

---

## 反向断言

- No **不允许**出现"对 blogger.googleusercontent.com 写死的 if 分支"
- No **不允许**出现"对某个文章站或 CDN host 写死的 if 分支"
- No **不允许**为通过这个场景而把所有 query 一刀切剔掉(那会把不同视频误归一条)
- No **不允许**因为 dedup 而把"页面里两个不同视频"合并

---

## 复演步骤

1. 准备一个本地 mhtml 页面,里面有一段 HTML:

   ```html
   <img src="https://blogger.googleusercontent.com/img/A=s320">
   <img src="https://blogger.googleusercontent.com/img/A=s640">
   <a href="https://blogger.googleusercontent.com/img/A=s1280">link</a>
   <img src="https://blogger.googleusercontent.com/img/B=s320"> <!-- 不同资源 -->
   ```

2. 通过 `axios + cheerio` 直接喂给 [sniffPage](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/sniffer.ts) 函数
3. 检查输出:**应当只有 2 条** SniffedMedia(A 一条 + B 一条)
4. 准备一组路径变体 URL,直接调用 [canonicalMediaDedupKey](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/mediaDedup.ts),断言:

   ```txt
   /v2/resize:fit:1400/format:webp/asset.gif
   /v2/resize:fit:1440/asset.gif
   ```

   归一到同一个 key,但 `asset.gif?id=a` 与 `asset.gif?id=b` 保持不同 key。无稳定文件名的 opaque endpoint 也不能因为 `token` / `signature` 不同就被强行合并,例如 `/media?token=a` 与 `/media?token=b` 必须保持不同 key。

---

## 关联规则

- [R-02 no-host-whitelist](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-02-no-host-whitelist.md)
- [docs/sniffer-rules.md §4](file:///Users/guoshuyu/workspace/gif-toolkit/docs/sniffer-rules.md)

---

## 历史 PASS 记录

| 日期 | 提交 | 结果 | 备注 |
|---|---|---|---|
| 初版沉淀 | dedupKey 引入 | PASS | 通用化,12/12 测试通过 |
| 2026-05-19 | True Chrome 路径变体归一 | PASS | 同一资源的 `resize:fit` / `format:webp` 变体合并;真实历史 8 条归一为 5 个不同素材 |
