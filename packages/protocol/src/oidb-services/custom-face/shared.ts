// Faceroam.OpReq 共用的常量与请求 inner 构造。
//
// 放在 custom-face/ 目录而不是上一层 oidb-services/shared.ts，因为这些值
// 只有 Faceroam 这一族操作要用——那边存的是所有 OIDB namespace 共享
// 的 toInt / ensureRetCodeZero 那一类小工具，混进去会让无关 service 也
// 看到 Faceroam 的版本号字符串。

import type { FaceroamOpReqInner } from '@snowluma/proto-defs/oidb-actions/base';

/** trpc service 名，sendRawPacket 的第一个参数。 */
export const FACEROAM_SERVICE = 'Faceroam.OpReq';

// 客户端版本标识。直接硬编码抓包看到的值——QQ 不同小版本之间这部分
// 理论上会变，但服务端对版本号并不敏感，先按当前目标版本写死，
// 真出问题再从 identity 里取。
/** osVersion 字符串，Faceroam inner 与 0x902e 业务体 f2 共用。 */
export const CLIENT_VERSION = '10.0.26200';
const CLIENT_BUILD = '9.9.26-44343';

/**
 * 构造请求 inner（field1 客户端环境）。fetch 带 qqVersion，delete 不带——
 * 这不是随手写的，是 wire dump 里两者 inner 长度差 14 字节的直接来源。
 */
export function makeInner(withQqVersion: boolean): FaceroamOpReqInner {
  const inner: FaceroamOpReqInner = { field1: 1, osVersion: CLIENT_VERSION };
  if (withQqVersion) inner.qqVersion = CLIENT_BUILD;
  return inner;
}
