场景布局审阅：独立静态托管包

与已发布的 Sites 快照相同：2026-10-13 / c00710ca122a。
包含页面、脚本、24 种素材和 A/B/C 底图，不依赖 chatgpt.site。
只包含审阅网站文件；不包含原项目仓库、Git 历史或托管凭证。

GitHub Pages 发布方式：
1. 将本包内容放在一个专用仓库的 main 分支根目录。
2. Settings > Pages > Build and deployment > Source：Deploy from a branch。
3. Branch：main，目录：/(root)，保存。
4. 等 GitHub 返回真实部署网址后，实际打开检查，再分享给同事。

请保留 .nojekyll；本网站没有构建步骤，无需安装 Node 或购买服务器。
公开仓库可使用 GitHub Free；私有仓库的 Pages 能力取决于账号计划。
官方说明：https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site

当前 chatgpt.site 链接在用户环境受到 Cloudflare 拦截。它仍显示已部署和公开，
但不能据此认定同事可访问。此包已准备就绪，尚未在 GitHub 创建仓库或发布。
