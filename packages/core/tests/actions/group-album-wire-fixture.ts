import type { bytes, int_32, pb, pb_repeated } from '@snowluma/proton';

interface GroupAlbumListReqDataWireOracle {
  groupId?: pb<1, string>;
  cursor?:  pb<2, string>;
}

interface GroupAlbumListExtWireOracle {
  key?:   pb<1, string>;
  value?: pb<2, string>;
}

export interface GroupAlbumListRequestWireOracle {
  seq?:     pb<1, int_32>;
  field2?:  pb<2, bytes>;
  field3?:  pb<3, bytes>;
  data?:    pb<4, GroupAlbumListReqDataWireOracle>;
  traceId?: pb<5, string>;
  extMap?:  pb_repeated<10, GroupAlbumListExtWireOracle>;
}

interface GroupAlbumMediaListReqInfoWireOracle {
  reserved?: pb<4, string>;
  pageInfo?: pb<5, string>;
}

export interface GroupAlbumMediaListRequestWireOracle {
  reqInfo?: pb<4, GroupAlbumMediaListReqInfoWireOracle>;
}
