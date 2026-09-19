# TexLite（Fork）

本仓库是 [TexLite 上游项目](https://github.com/SWUFE-DB-Group/TexLite) 的 fork，
fork 仓库地址为 [ChenZhongPu/TexLite](https://github.com/ChenZhongPu/TexLite)。

本 fork 将 TexLite 从面向私有小团队的部署，调整为支持公网部署和开放注册的平台。

## 本 fork 的改动

- **开放用户系统**：支持 GitHub OAuth 登录、分页用户管理、用户个人信息和密码自助管理，
  并使用带身份提供方的账号唯一标识。
- **项目权限**：注册用户默认可以创建项目。邀请通过邮箱发出，同时展示匹配到的用户名；
  被邀请者必须明确接受后，才会成为项目成员。
- **项目分享**：项目所有者可以生成和撤销只读链接。只有链接权限的用户必须通过链接打开项目，
  不会出现在项目列表中，也不能批注或使用 `@` 提及；写权限必须通过明确加入项目获得。撤销链接
  不会移除已经加入项目的成员。
- **协作功能**：已加入项目的用户继续支持成员权限、批注、提及和协作者状态展示。
- **安全调整**：不再支持项目中的 `latexmkrc` 文件。
- **移除功能**：去掉 Git 集成功能。

安装、部署和开发配置不在本 README 中重复说明，基础内容请参考
[上游项目](https://github.com/SWUFE-DB-Group/TexLite)。

## 反向代理与真实客户端 IP

本地密码登录的限流会使用 `X-Forwarded-For` 中的客户端 IP，但仅当 TexLite 的
TCP 直连对端属于 `server.trustedProxyIps` 时才会信任该请求头。默认值为
`["127.0.0.1", "::1"]`，适用于代理与 TexLite 运行在同一台主机的情形。

### Caddy（同机部署）

将 TexLite 保持在 `127.0.0.1:3000`，Caddyfile 只需：

```caddyfile
tex.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Caddy 的 `reverse_proxy` 会自动设置安全的 `X-Forwarded-For`、
`X-Forwarded-Proto` 和 `X-Forwarded-Host`，无需额外 `header_up` 配置。
因此上述默认 `trustedProxyIps` 即可让 TexLite 获取客户端 IP，并正确识别 HTTPS。

若 Caddy 与 TexLite 位于不同容器或不同主机，将 `trustedProxyIps` 改为 Caddy
连接 TexLite 时使用的实际 IP 或 CIDR，例如：

```json
{
  "server": {
    "trustedProxyIps": ["172.20.0.0/16"]
  }
}
```

不要使用 `0.0.0.0/0`。若 Caddy 前还有 CDN、负载均衡器或另一层代理，应在 Caddy
中仅信任该上游服务公布的 CIDR，并启用严格的从右至左解析：

```caddyfile
{
    servers {
        trusted_proxies static <上游代理的CIDR>
        trusted_proxies_strict
    }
}
```

详见 [Caddy reverse_proxy 文档](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)
和 [Caddy trusted_proxies 文档](https://caddyserver.com/docs/caddyfile/options)。

## 许可证

TexLite 使用 GNU Affero General Public License v3.0，详见
[LICENSE](LICENSE) 和 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
