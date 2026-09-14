import type { pb, pb_repeated, uint_32, uint_64, bytes } from '@snowluma/proton';

/** Header identifying the source/destination device on a my-device chat. */
export interface DatalineMsgHeader {
  srcAppId?: pb<1, uint_32>;
  srcInstId?: pb<2, uint_32>;
  dstAppId?: pb<3, uint_32>;
  dstInstId?: pb<4, uint_32>;
  dstUin?: pb<5, uint_64>;
  srcUin?: pb<6, uint_64>;
  srcUinType?: pb<7, uint_32>;
  dstUinType?: pb<8, uint_32>;
  srcTerType?: pb<9, uint_32>;
  dstTerType?: pb<10, uint_32>;
}

/** File notify carried on a my-device transfer. */
export interface DatalineFtnNotify {
  sessionId?: pb<1, uint_64>;
  fileName?: pb<2, string>;
  fileIndex?: pb<3, string>;
  fileMd5?: pb<4, bytes>;
  fileKey?: pb<5, string>;
  fileLen?: pb<6, uint_64>;
}

/** Generic my-device command; text lives in `buf`. */
export interface DatalineGenericSubCmd {
  sessionId?: pb<1, uint_64>;
  size?: pb<2, uint_32>;
  index?: pb<3, uint_32>;
  type?: pb<4, uint_32>;
  buf?: pb<5, bytes>;
}

export interface DatalineTextItem {
  type?: pb<1, uint_32>;
  text?: pb<2, bytes>;
}

export interface DatalineTextMsg {
  items?: pb_repeated<1, DatalineTextItem>;
}

export interface DatalineMsgBody {
  subCmd?: pb<1, uint_32>;
  header?: pb<2, DatalineMsgHeader>;
  ftn?: pb_repeated<3, DatalineFtnNotify>;
  generic?: pb<6, DatalineGenericSubCmd>;
}
