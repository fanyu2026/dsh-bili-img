# dsh-bili-img

给 DSH（DeepSeek Harness）里的 agent 加一个能力：**在 B站 发图**。

- 私信发图（默认只发给主人 mid）
- 评论区发图（视频、动态都行；支持回复某条评论）
- 发前裁剪：`crop=left,top,right,bottom`，把截图白边削掉
- 删自己发的评论（`action=del`），方便测试完擦干净

默认 **dry-run**：只回显要做什么，`go=true` 才真的上传/发送。

## 装

```bash
dsh plugin --profile <你的 profile> add github:fanyu2026/dsh-bili-img
# 或者本地开发：dsh plugin --profile <你的 profile> add link:/path/to/dsh-bili-img
# 然后重启 app（插件在启动时加载）
```

## 凭据

不经过插件，脚本直接读 `~/.bili-ai/credentials.json`（字段：`sessdata` / `bili_jct` / `buvid3` / `dedeuserid`，与 [dsh-bili-whale](https://github.com/) 共用同一份）。
没有凭据就去 whale 的设置页扫码登录。

## 命令行也能直接用

```bash
node tools/bili-img.mjs upload  --file a.jpg
node tools/bili-img.mjs dm      --file a.jpg --go
node tools/bili-img.mjs comment --file a.jpg --oid 1262356463860318231 --type 17 --message "看图" --go
node tools/bili-img.mjs del     --oid 1262356463860318231 --type 17 --rpid 123 --go
```

## 接口备忘

- 上传图床：`POST https://api.bilibili.com/x/dynamic/feed/draw/upload_bfs`（multipart：`file_up` / `category=daily` / `csrf`）
- 私信图片：`POST https://api.vc.bilibili.com/web_im/v1/web_im/send_msg`，`msg_type=2`，`content={url,width,height,imageType,original:1,size}`
- 评论图片：`POST https://api.bilibili.com/x/v2/reply/add`，图片字段名是 **`picture`**（JSON 字符串数组：`[{img_src,img_width,img_height,img_size}]`）
- 删评论：`POST https://api.bilibili.com/x/v2/reply/del`

## License

MIT
