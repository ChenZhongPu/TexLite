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

## 许可证

TexLite 使用 GNU Affero General Public License v3.0，详见
[LICENSE](LICENSE) 和 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
