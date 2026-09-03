# GPT 执行链硬验收合同(2026-09-03 自 rules-corpus 出库)

来源:rules-corpus.jsonl 中的「GPT全链硬验收」规则(2090 字,P0-P18),2026-09-03 规则投影退役时移到本文档,不再作为行为规则注入模型上下文。修改或验收 GPT/Codex 执行链、8794 桥、历史注入、规则路由、缓存或五类基准时,按本合同逐门核对。

注意:P10 提到的桥内 tier/reasoning 改写与 persistence 注入已在桥 v8 slim(2026-09-02)撤掉,S2/S3/S4 自 lop-chain v23 起 fail-open,相关门按现行实现解释。

原触发词(供检索):`(?:(?:GPT|Codex|8794).{0,48}(?:执行路径|执行链|全链路|链路|会话路径|会话链|历史摘要|HISTORY_RESOLVER|规则路由|联想扩写|五类任务|五链|cache|memo|缓存代理|阶段耗时|执行慢|响应慢)|(?:执行路径|执行链|全链路|链路|会话路径|会话链|历史摘要|规则路由|联想扩写|五类任务|五链|阶段耗时).{0,48}(?:GPT|Codex|8794))`

## 合同全文

修改或验收GPT/Codex执行链、8794、HISTORY_RESOLVER、规则路由、联想层、cache/memo或五类基准时，本条是交付硬门；
不得降低模型可见事实、历史四阈值、规则召回、有效reasoning、工具/读回验证或答案正确性换速度。当前最小链及逐步门：P0从完成态历史按截止点重新统计前五类及频次，冻结prompt/环境/代码/规则hash和同分支有效历史最佳B0，固定五题或无完成态/零token/错误/未完成/memo样本不得冒充频率或cold基线；
P1 UserPromptSubmit唯一事件含session/turn/原文且仅触发一次；
P2宿主确定性扩写，有效去重语义单元总数/原单元数≥3.0，每个新增单元带本人历史纠正、实体或规则词族来源，禁填充；
P3同一快照逐条遍历全量非alwaysOn规则，以只看prompt+规则id/text、不看trigger和实际A的独立oracle产出E并记录corpus hash，adapter日志、注入正文解析出的A必须与E集合完全相等且truncated=false，不能只比条数；
P4 exact仅normalized_prompt_hash及允许完成源；
P5 assoc仅canonical完成态+允许raw FTS5/BM25，任务型一致、summary20非待处理、锚点≥75%、summary命中锚点、语义≥0.10、相关≥0.82、异意图领先≥0.08并意图族去重，否则零注入；
P6 summary20与full≤800字分别通过相关性审定，且工具参数/动作/final分别出现summary独有锚点和full独有正确细节；
匹配usage的history-used/conflict只算账本，不单独证明使用，需用summary遮蔽、full遮蔽、全关闭三组反事实得到预声明的行为差异；
P7规则、历史、来源、usage和字节数完整渲染，历史明确非指令，预算截断即失败；
P8当前账号实际provider必须到127.0.0.1:8794/v1，监听PID/版本与配置一致；
P9 /health=200与无凭据真实/v1/responses=401分别通过，但都不得替代带登录身份的端到端成功；
P10代理解压/解析/兼容剥离/tier/reasoning/cache-key改写前后模型可见内容除获准字段逐字等价，实际发往上游的reasoning另记，不能用config的ultra掩盖代理改成low；
P11 response-memo hit、prompt-cache hit、cold miss分账，memo key必须覆盖模型可见请求、history usage与工具回执，变化状态/失败/计时题不得错误复用，任一路径不能给另一条作基线；
P12上游出口、CONNECT、TLS、认证、HTTP状态、排队、首包前至多一次重试分别可观测，收到首包后严禁重放；
P13 SSE首包、增量流、response.completed、usage和结束边界完整，客户端取消/流错不得记成功；
P14首轮模型必须对P2/P5/P6产生可归因作用，高置信历史只缩短到当前边界下的最小可失败动作，不得跳过验证；
P15 Skill一次合批、PreToolUse、工具argv/权限/副作用/hidden、工具完成逐项通过；
P16当前状态同调用或同快照读回，历史冲突以当前为准；
P17 final正确、无未声明缺口，Stop仅一次写最终完成态且summary20/full/usage可回查；
P18 RULE/HISTORY/proxy/rollout/Stop时间戳可关联，阶段互斥和总时长可对账，临时状态清理。三项因果总门：历史每张卡相关率与summary/full实际使用率均100%；
全规则A=E；
扩写开/关A/B须让正确历史或规则命中产生正增益且误命中不增，五类口语变体漏命中下降≥80%，否则倍率不算达标。性能门：cold/cache/memo按前五类分别建账；
只管B0>1s阶段，第2次起每个有效实测都须严格<B0×0.50，B0在本次验收内冻结、交付后才棘轮，≤1s阶段不得回归到>1s；
只豁免compact与理论最少模型/工具次数，harness启动开销另列但不得从live用户链消失。任一门失败必须保留证据并重跑该类完整链；
共享组件变化重跑五类；
同指标两次定向修正失败立即复核架构，不叠补丁。仅耗时可判无法提升：至少两种架构级方案、每方案同条件≥3次，覆盖宿主批处理、上下文/cache/memo、模型轮次、8794连接/并发/出口且改善均<5%，同时正确性和三项因果门全绿；
相关性、A=E、扩写因果、准确性、真实动作无豁免。交付须五类各一次真实新会话最小完整链+同题harness，live为准；
另覆盖exact/assoc/miss、规则0/1/多条、扩写开关、memo hit/miss、cold、401、状态改变与失败输出；
代理切换走静态校验→旁路真实启动→401→带身份端到端→切换→切后复验。
