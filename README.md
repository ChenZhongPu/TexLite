# TexLite（Fork）

本仓库是 [TexLite 上游项目](https://github.com/SWUFE-DB-Group/TexLite) 的 fork，
fork 仓库地址为 [ChenZhongPu/TexLite](https://github.com/ChenZhongPu/TexLite)。

本 fork 将 TexLite 从面向私有小团队的部署，调整为支持公网部署和开放注册的平台。

## 本 fork 的改动

- **开放用户系统**：接入 Nuwax OAuth，使用 Nuwax 返回的 `sub` 作为稳定的账号关联键；
  用户名和显示名都支持在个人页面修改，长度上限均为 50。邮箱不是必填项，未返回邮箱的用户也可以正常注册和登录。
- **项目权限**：注册用户默认可以创建项目。邀请使用 Nuwax 的手机号精确检索，检索结果会显示用户名和显示名；
  手机号只用于检索，不写入 TexLite。被邀请者必须明确接受后，才会成为项目成员。
- **项目分享**：项目所有者可以生成和撤销只读链接。只有链接权限的用户必须通过链接打开项目，
  不会出现在项目列表中，也不能批注或使用 `@` 提及；写权限必须通过明确加入项目获得。撤销链接
  不会移除已经加入项目的成员。
- **协作功能**：已加入项目的用户继续支持成员权限、批注、提及和协作者状态展示。
- **安全调整**：不再支持项目中的 `latexmkrc` 文件。
- **移除功能**：去掉 Git 集成功能和项目所有权转让功能。

安装、部署和开发配置不在本 README 中重复说明，基础内容请参考
[上游项目](https://github.com/SWUFE-DB-Group/TexLite)。

## Nuwax OAuth 配置

在配置文件中填写管理员登记的 Nuwax OAuth 信息。示例中的 `redirectUri` 故意留空，必须由管理员
根据 Nuwax 应用后台登记的地址显式填写；本地测试时通常是
`http://localhost:3001/auth/nuwax/callback`。

```json
{
  "OAuth": {
    "baseURL": "https://testagent.xspaceagi.com",
    "clientId": "",
    "clientSecret": "",
    "redirectUri": ""
  }
}
```

应用需要登记 `user:search` scope。TexLite 按 Nuwax 的既有约定使用逗号分隔的
`profile,user:search`，不是空格分隔。Client Secret 只放在服务端配置或环境变量中，不要提交到 Git。
项目所有者首次使用手机号邀请前，需要先通过 Nuwax 登录一次，以便服务端取得带有该用户租户上下文的访问令牌。

本地测试不需要保留旧数据；删除 `data` 目录后重新启动即可按当前配置初始化。

## PostgreSQL（全新部署）

测试期不需要从 SQLite 导入数据。先在 PostgreSQL 中创建一个空数据库（例如 `texlite-demo`），
然后以 [texlite.postgres.config.example.json](texlite.postgres.config.example.json) 为基础配置 PostgreSQL；
表结构由 TexLite 的版本化迁移自动创建。

```json
{
  "storage": {
    "dataDir": "./data-postgres"
  },
  "database": {
    "driver": "postgresql",
    "url": "postgresql://postgres:CHANGE_ME@127.0.0.1:5432/texlite-demo",
    "sslMode": "disable"
  }
}
```

连接串格式为：

```text
postgresql://<用户名>:<密码>@<主机>:<端口>/<数据库名>
postgresql://postgres:CHANGE_ME@127.0.0.1:5432/texlite-demo
             └用户名┘ └──密码──┘ └─主机──┘ └端口┘ └数据库名┘
```

因此，对本地已创建的 `texlite-demo`、用户为 `postgres` 的数据库，只需将示例中的
`CHANGE_ME` 替换为 PostgreSQL 用户密码。不要把带密码的连接串提交到 Git；公网部署建议将完整
连接串放在 `TEXLITE_DATABASE_URL` 环境变量中，配置文件可保留占位值以说明连接目标。若数据库
要求 TLS，将 `sslMode` 设为 `require`。

当前 fork 仅支持 PostgreSQL。`drizzle/postgres/` 中的版本化迁移会在应用启动时自动执行；首次部署
前只需创建空数据库，然后运行 `npm run init` 创建首个管理员。测试阶段不提供旧 SQLite 数据迁移。

可选的 PostgreSQL 并发集成测试使用 `TEXLITE_TEST_DATABASE_URL` 指向一个控制数据库；测试会为
每个用例创建并删除独立临时数据库，不会写入该控制数据库。该连接账号需具备 `CREATEDB` 权限：

```bash
TEXLITE_TEST_DATABASE_URL='postgresql://postgres:密码@127.0.0.1:5432/postgres' npm test
```

`storage.dataDir` 只保存项目文件、编译产物、回收站和实例锁，数据库表由 PostgreSQL 服务管理。
`npm run dev` 会把配置和文件数据固定在当前源码目录；本地配置中的数据库连接仍指向你配置的
PostgreSQL 实例。切换数据库时建议使用新的 `dataDir`，避免文件目录与数据库中的项目记录不一致。

## 公网部署配额

默认配置会限制每个账户最多拥有 100 个项目，且所有项目的源码、上传附件总量最多为
2048 MB（2 GB）。限制会在新建、导入、复制、上传、编辑、批量替换、历史恢复和协作自动保存时
执行；可在 `projects.maxProjectsPerUser` 和 `projects.maxSourceStorageMBPerUser` 调整。
也可分别通过 `TEXLITE_MAX_PROJECTS_PER_USER` 和
`TEXLITE_MAX_PROJECT_SOURCE_STORAGE_MB` 环境变量覆盖。
这两项限制的是用户可控制的项目源码。编译缓存、PDF 产物和编译进程资源仍应结合
`history`、`editHistory` 配置及宿主机/容器资源限制单独管理。

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
