#!/usr/bin/env node
// 2026-08-29 起发行物只构建脱敏 base.exe；敏感资产与规则不再打进 assets.enc。
// 规则唯一真值由 vscodium/tools/sync.mjs 单向生成本机 pi 快照，异机通过 SSH
// 把 canonical corpus 推到 data/registry/rules-corpus.jsonl，再由 src/rules-snapshot.mjs
// 原子生成 data/rules.jsonl。保留本入口只为明确阻止旧打包链复活。
console.error("pack-my-assets 已退役：禁止生成或嵌入 assets.enc；请使用 canonical rules 单向同步链。");
process.exit(1);
