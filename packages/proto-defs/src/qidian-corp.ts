import type { pb, uint_32 } from '@snowluma/proton';

// trpc.basic.corp.Datacard.SsoCorpInfo — 企点企业资料卡信息。
// 请求：field1 = 目标账号 UIN（varint）。
// 响应字段为企点企业资料卡：名称 / 简介 / 官网 / 企业签名 / 地址 / 电话 / 邮箱。
export interface QidianCorpInfoRequest {
  uin?: pb<1, uint_32>;
}

export interface QidianCorpInfoResponse {
  corpName?: pb<2, string>;
  intro?:    pb<3, string>;
  website?:  pb<4, string>;
  slogan?:   pb<5, string>;
  address?:  pb<6, string>;
  phone?:    pb<7, string>;
  email?:    pb<8, string>;
}
