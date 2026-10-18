export const DEFAULT_WEBHOOK_BODY = `{
  "title": "账号状态通知：{event}",
  "desp": "您的账号状态发生了改变。\\n\\n**昵称**：{nickname}\\n**QQ号**：{uin}\\n**当前状态**：{event}\\n**进程状态**：{status}\\n**时间**：{time}"
}`;

export const DEFAULT_EMAIL_SUBJECT = '账号{event}：{nickname} ({uin})';

export const DEFAULT_EMAIL_BODY = `账号状态发生了改变。

昵称：{nickname}
QQ号：{uin}
当前状态：{event}
进程状态：{status}
时间：{time}`;
