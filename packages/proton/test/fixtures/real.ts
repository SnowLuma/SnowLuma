interface TestProtobuf {
    name: pb<1, uint_32>;
}

interface TestProtobufOutput {
    name: pb<1, TestProtobuf>;
}

const data = protobuf_encode<TestProtobuf>({ name: 123 });
const decoded = protobuf_decode<TestProtobufOutput>(data);

export { };
