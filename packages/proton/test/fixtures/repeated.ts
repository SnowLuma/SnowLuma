interface RepeatedMsg {
    ids: pb_repeated<1, uint_32>;
    names: pb_repeated<2, string>;
}

const data = protobuf_encode<RepeatedMsg>({ ids: [1, 2, 3], names: ["a", "b"] });
const decoded = protobuf_decode<RepeatedMsg>(data);

export { };
