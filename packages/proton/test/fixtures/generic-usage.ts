interface TestProtobufAny<T> {
    name?: pb<1, T>;
}

const dataT = protobuf_encode<TestProtobufAny<TestProtobufAny<string>>>({ name: { name: "test" } });
const decodedT = protobuf_decode<TestProtobufAny<TestProtobufAny<string>>>(dataT);

export { };
