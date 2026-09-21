# TexLite 生产环境初始化与启动

本文说明 PostgreSQL 全新部署时的初始化流程。假设 PostgreSQL 服务已经运行，但
目标数据库为空，尚未创建任何 TexLite 数据表。

## 1. 创建空 PostgreSQL 数据库

先创建数据库和应用使用的数据库用户。例如：

```text
数据库：texlite
用户：texlite
```

数据库用户至少需要具备连接数据库、创建表和修改表结构的权限。

不需要手动创建 TexLite 的表，应用的版本化迁移会自动完成这一步。

## 2. 准备生产配置

建议把配置文件放在应用目录之外，例如：

```text
/etc/texlite/texlite.config.json
```

配置文件至少需要包含：

```json
{
  "server": {
    "host": "127.0.0.1",
    "port": 3000
  },
  "storage": {
    "dataDir": "/var/lib/texlite/data"
  },
  "database": {
    "driver": "postgresql",
    "sslMode": "require"
  }
}
```

将数据库连接串放在环境变量中，不要提交到 Git：

```bash
export TEXLITE_CONFIG=/etc/texlite/texlite.config.json
export TEXLITE_DATABASE_URL='postgresql://texlite:密码@127.0.0.1:5432/texlite'
```

如果密码中包含 `@`、`:`、`/`、`#` 等特殊字符，需要按 URL 规则进行编码。

`storage.dataDir` 只保存项目文件、编译产物、回收站和实例锁；数据库表由 PostgreSQL
管理。该目录必须允许 TexLite 运行用户读写，并应纳入备份策略。

## 3. 构建程序

源码部署时执行：

```bash
npm ci
npm run build
```

构建完成后，生产环境可以使用 `dist/` 中的编译结果启动。

## 4. 初始化数据库和首个管理员

推荐使用编译后的 CLI：

```bash
node dist/server/cli.js init
```

如果仍然在源码目录中运行，也可以使用：

```bash
npm run init
```

初始化命令会自动完成：

1. 读取并校验 TexLite 配置；
2. 连接 PostgreSQL；
3. 执行 `drizzle/postgres/` 中尚未执行的迁移；
4. 创建数据库表；
5. 创建第一个管理员账户。

可以交互式输入管理员信息。也可以通过环境变量进行非交互式初始化：

```bash
export TEXLITE_INIT_USERNAME=admin
export TEXLITE_INIT_DISPLAY_NAME=Administrator
export TEXLITE_INIT_PASSWORD='请替换为强密码'

node dist/server/cli.js init
```

管理员密码不要写入配置文件、Shell 脚本或 Git。生产部署时应使用受保护的 secret
文件、服务管理器的安全环境变量或 Secret Manager。

如果数据库中已经存在有效管理员，`init` 会拒绝再次初始化，以避免误创建首个管理员。

## 5. 启动服务

### 前台启动

适合容器或 systemd 管理：

```bash
npm start
```

### 使用 PM2

```bash
npm run pm2:start
npm run pm2:save
```

启动命令必须继承 `TEXLITE_CONFIG` 和 `TEXLITE_DATABASE_URL` 等环境变量。例如在启动
PM2 前先加载生产环境变量：

```bash
source /etc/texlite/texlite.env
npm run pm2:start
npm run pm2:save
```

启动时应用会再次执行尚未完成的迁移，并检查数据库中是否存在至少一个有效管理员。

## 6. 后续版本升级

开发者修改 `src/server/database/schema/postgres.ts` 后，先生成迁移文件：

```bash
npm run db:generate:postgres
```

检查 `drizzle/postgres/` 中生成的 SQL，并将迁移文件提交到 Git。这个命令只生成迁移
文件，不会修改生产数据库。

部署新版本时，应用启动会自动执行未完成的迁移。也可以在启动应用前显式执行：

```bash
node dist/server/database/migrate.js
```

在源码环境中则可以使用：

```bash
npm run db:migrate:postgres
```

`db:migrate:postgres` 使用 TexLite 的实际配置和数据库连接；它不是生成迁移文件的命令。

## 7. 首次部署流程总结

```text
创建空 PostgreSQL 数据库
        ↓
配置 TEXLITE_CONFIG、TEXLITE_DATABASE_URL 和 storage.dataDir
        ↓
npm ci && npm run build
        ↓
node dist/server/cli.js init
        ↓
启动 TexLite
```

首次部署不需要手动创建表，也不需要先执行 `db:generate:postgres`。只有修改数据库
Schema 后，才需要生成新的迁移文件。
