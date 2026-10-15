# 人工两阶段布局

在线入口：https://licogithub.github.io/scene-layout-review/manual-layout/

在线版支持查看、建筑拖动、建筑/设施/角色缩放、撤销、各自浏览器保存和导出JSON/PNG。载具为0时禁用。GitHub Pages不运行Python，补量和真实检验按钮禁用，绝不模拟插件成功。

完整本机运行（Python 3.10+）：

```sh
python -m pip install -r tools/manual-layout/requirements.txt
# 设置 TMC_LAYOUT_PLUGIN_ROOT 为安装的 tmc-level-layout 0.12.3 插件根目录（含 scripts/）。
python tools/manual-layout/portable_server.py --port 8844
```

打开 http://127.0.0.1:8844/manual-layout/。第一次自动复制随仓库的基准快照到 outputs/manual-layout/user-workspace；再次启动保留自己的草稿，进行中的旧任务不会自动重跑。服务只监听本机。

源插件：https://github.com/WitMani/tmc-level-designer-plugin 。当前适配器依赖0.12.3及其CLI合同，不包含或改写插件核心。TMC_LAYOUT_PLUGIN_ROOT 未设置时查找当前用户的Codex该版本缓存。未安装插件仍可手动编辑；点击补量会明确报错。

阶段1支持建筑拖动和三类整体/原型缩放；阶段2只缩放并固定所有锚点。确认按钮才运行真实插件。数量维持24种/162件/21寻物目标（目标包含在总量）、0载具、6组既定叠放。已有基础81件，完整观察209条另存，未采纳128条不偷偷加入。脚底不因改大小移动。100%是烘焙后的当前基准。

跨人协作：在线调整后导出JSON；本机先返回基础阶段，点击“导入调整JSON”。仅导入同基准的尺寸与基础建筑位置，不直接接收别人的补充件，也不自动运行插件。确认后重新补量。导入可撤销，错误文件不修改草稿。

基准和当前快照包含未解决的地形、拥挤、边缘及屋顶支撑问题。数量齐不等于通过，真实渲染/几何诊断和人工视觉验收分别进行。在线保存各自独立，不会改变本机用户草稿或其他访客的保存。
