# @snowluma/proton

用于 SnowLuma 的编译时 protobuf 编码器/解码器生成器。输入 TypeScript 接口，输出完全内联、零运行时的编解码函数。

> 该项目衍生自（Vendored自）[SnowLuma/protobuf-dsl](https://github.com/SnowLuma/protobuf-dsl)
> 并修复了若干边缘情况。未做修改的上游源码保留在 `dev/protobuf-dsl/` 下作为参考副本。

## 功能特性

你只需使用 `pb<N, T>` 标记的普通 TypeScript 接口来声明你的传输 Schema。在构建时，一个 Vite 插件会扫描 `protobuf_encode<T>` / `protobuf_decode<T>` 的调用位置，并将它们替换为特定于类型的、完全内联的编解码函数。无需运行时 Schema 查找，无需反射，无需 `.proto` 文件，也无需 `protoc`。

```ts
import type { pb, pb_repeated, uint_32, bool } from '@snowluma/proton';
import { protobuf_encode, protobuf_decode } from '@snowluma/proton';

interface UserProfile {
  id?:       pb<1, uint_32>;
  username?: pb<2, string>;
  active?:   pb<3, bool>;
  tags?:     pb_repeated<4, string>;
}

const bytes = protobuf_encode<UserProfile>({
  id: 42, username: 'alice', active: true, tags: ['admin'],
});
const user = protobuf_decode<UserProfile>(bytes);

```

经过插件转换后，上述代码会变成：

```js
// 预计算的 Tag 字面量、内联的 varint 循环、无函数调用开销
const bytes = protobuf_encode_UserProfile({ id: 42, ... });
const user  = protobuf_decode_UserProfile(bytes);

```

如果**未安装**该插件，调用 `protobuf_encode` / `protobuf_decode` 将直接抛出明显的错误，而不是静默生成错误的字节数据。

## 在 SnowLuma 中配置

该包已经内置到 `@snowluma/core` 的 `vitest.config.ts` 中。若要在 Monorepo 的其他地方使用：

```ts
// vite.config.ts (或 vitest.config.ts)
import { defineConfig } from 'vite';
import protobufVitePlugin from '@snowluma/proton/vite';

export default defineConfig({
  plugins: [protobufVitePlugin()],
});

```

添加工作区依赖：

```json
{
  "dependencies": { "@snowluma/proton": "workspace:*" }
}

```

## 原生类型

标记格式为 `pb<FieldNumber, Type>`（数组则使用 `pb_repeated<FieldNumber, Type>`）。可用的原生类型包括：

| 标记 | TS 类型 | 传输格式（Wire） |
| --- | --- | --- |
| `bool` | `boolean` | varint |
| `uint_32` | `number` | varint |
| `int_32` | `number` | varint |
| `sint_32` | `number` | varint (zigzag) |
| `uint_64` | `bigint` | varint |
| `int_64` | `bigint` | varint |
| `sint_64` | `bigint` | varint (zigzag) |
| `fixed_32` | `number` | 32-bit |
| `fixed_64` | `bigint` | 64-bit |
| `sfixed_32` | `number` | 32-bit |
| `sfixed_64` | `bigint` | 64-bit |
| `float` | `number` | 32-bit |
| `double` | `number` | 64-bit |
| `string` | `string` | length-delimited |
| `bytes` | `Uint8Array` | length-delimited |

此外，还支持消息类型（任何其他带有 `pb<>` 标记字段的接口），作为 `pb<>` / `pb_repeated<>` 的第二个类型参数。

## 泛型模板

你可以将可复用的包装器声明为泛型接口：

```ts
interface Wrapper<T> {
  value?: pb<1, T>;
}

const bytes = protobuf_encode<Wrapper<uint_32>>({ value: 42 });
//                               ^ 在调用处实例化

```

嵌套实例化同样有效 —— `Wrapper<Wrapper<string>>` 会被单态化（mono-morphizes）为 `Wrapper__string` + `Wrapper__Wrapper__string`，并且在构建时两者都会进入注册表。

你可以在具体接口中组合它们：

```ts
interface Container {
  wrapped?: pb<5, Wrapper<uint_32>>;
}

```

……或者在其他泛型模板中组合：

```ts
interface Outer<U> {
  wrapped?: pb<5, Wrapper<U>>;
}
const bytes = protobuf_encode<Outer<uint_32>>({ wrapped: { value: 42 } });

```

这两种形式均已通过回归测试。

## 跨文件与包装器绑定

Schema 和调用位置可以位于不同的文件中：

```ts
// schema/user.ts
export interface UserProfile { id?: pb<1, uint_32>; }

// usage.ts
import type { UserProfile } from './schema/user';
import { protobuf_encode } from '@snowluma/proton';
const bytes = protobuf_encode<UserProfile>({ id: 42 });

```

你也可以围绕 `protobuf_encode` / `_decode` 构建轻量级的泛型包装函数，插件会对其进行追踪，即使跨越文件边界也适用：

```ts
// schema/wrap.ts
export function encodeWrapped<T>(v: Wrapper<T>): Uint8Array {
  return protobuf_encode<Wrapper<T>>(v);
}

// usage.ts
import { encodeWrapped } from './schema/wrap';
const bytes = encodeWrapped<string>({ value: 'hi' });
//              ^ 插件会将其重写为 protobuf_encode_Wrapper__string(...)

```

链式转发同样有效（例如：`A` 转发给 `B`，而 `B` 是从另一个模块导入的，依此类推）。

## 静态方法包装器（每个子类的重写）

有时，你可能希望抽象基类只保留一次编码/解码管道，而让每个子类仅提供对应请求/响应结构的辅助方法：

```ts
import { protobuf_encode, protobuf_decode } from '@snowluma/proton';

abstract class PacketTransformer {
  static encode<R, T extends { serialize: (ctx: unknown, p: never) => R }>(
    this: T,
    ctx: unknown,
    params: T['serialize'] extends (ctx: unknown, p: infer P) => R ? P : never,
  ): Uint8Array {
    return protobuf_encode<R>((this as any).serialize(ctx, params));
  }

  static decode<B, Res, T extends { deserialize: (ctx: unknown, body: B) => Res }>(
    this: T,
    ctx: unknown,
    bytes: Uint8Array,
  ): Res {
    return (this as any).deserialize(ctx, protobuf_decode<B>(bytes));
  }
}

class DemoTransformer extends PacketTransformer {
  static serialize(_ctx: unknown, p: DemoReq): DemoReqPb { /* … */ }
  static deserialize(_ctx: unknown, b: DemoResPb): DemoRes { /* … */ }
}

// 自然地调用继承的方法：
const bytes  = DemoTransformer.encode(undefined, { /* … */ });
const result = DemoTransformer.decode(undefined, bytes);

```

抽象体内部的 `protobuf_encode<R>` / `protobuf_decode<B>` 无法进行静态替换 —— 因为 `R` 和 `B` 在运行时会被擦除。Proton 通过以下方式处理此问题：

1. **检测**满足以下条件的类：其静态方法 (a) 接收类型参数，(b) 调用 `protobuf_encode<R>` / `protobuf_decode<R>` 且其中 `R` 是这些参数之一，以及 (c) 使用 `this: T extends { … }` 进行约束，且该参数出现在约束内部。
2. **利用 TypeScript 的 TypeChecker** —— 基于项目的 `tsconfig.json` 延迟构建 —— 遍历文件中每个子类的 `extends` 链（包含跨文件边和路径别名），并将包装器的类型参数与子类的同级方法签名进行解析（在此示例中，`R` 对应 `serialize` 的返回值类型，`B` 对应 `deserialize` 的主体参数类型）。
3. 在类声明后**追加**一个针对每个子类的重写（Override）：
```js
DemoTransformer.encode = function (ctx, params) {
  return protobuf_encode_DemoReqPb(this.serialize(ctx, params));
};

```



原始的调用位置保持不变 —— 运行时调度会自然地找到重写方法，因为静态属性存在于构造函数上。抽象基类的主体也会保持原样，且永远不会被调用。

这种命名方式是结构化的，而非配置出来的：

* 包装器方法可以命名为任何名称（`encode`、`enc`、`request` 等）—— Proton 只关注主体和约束的形状。
* 同级方法的名称是从 `this: T extends { … }` 约束中读取的，因此 `serialize`/`deserialize`、`build`/`parse` 或任何其他组合都可以正常工作。
* 多层继承（`Leaf → MidBase → AbstractBase`）会被 TypeChecker 全程追踪。

如果同级方法缺少显式的返回值/参数类型注解，将使用检查器推导出的类型作为兜底。只有当包装器主体中的每个编解码器调用都成功解析时，才会输出重写代码 —— 部分解析会在运行时产生死标识符引用，因此“全有或全无（all-or-nothing）”的规则是故意为之的。

## proto3 默认值语义

**重要的行为细节。** Proton 遵循 proto3 传输格式规范：如果字段的值等于该类型的默认值（`0` / `false` / `""` / 空字节），则**不会**在网络传输中输出。这在字节层面上与 SnowLuma 旧版始终输出每个字段的 `protoEncode` 运行时不同。

这两种形式与任何符合规范的 proto3 读取器都是网络兼容的（缺失的字段会解码为默认值）。在将旧版 Schema 迁移到 Proton 时，**请勿**将默认值上的字节级不一致视为回归故障 —— 参见 [`packages/core/tests/proton-parity.test.ts`](https://www.google.com/search?q=../../packages/core/tests/proton-parity.test.ts) 中固定此差异的测试。

如果你的网络数据消费者依赖于字节级的完全一致（例如用于哈希或签名），建议显式设置非默认值，而不是依赖编码器。

## 诊断机制

任何无法解析为原生类型或已注册消息的内容都会**在构建时抛出错误**，而不是静默泄露错误的传输类型：

```
Cannot resolve protobuf field type "Partial__UserProfile" on message "Foo"
(field "bar", field number 3). The analyzer did not produce a primitive or
registered message for this type. Common causes: union / intersection /
mapped / conditional types, TypeScript utility types (Partial<T>, Pick<T>, …),
qualified names (ns.Type), or a missing import.

```

这是针对分析器无法建模的 TypeScript 结构的的安全网。目前不支持的特性包括：

* 联合/交叉类型（`A | B`，`A & B`）
* 条件/映射类型（`T extends X ? A : B`，`{ [K in keyof T]: ... }`）
* TS 工具类型（`Partial<T>`，`Pick<T>`，`Readonly<T>` 等）
* 限定类型名称（`ns.Type`）
* 通过命名空间导入访问的包装函数（`import * as ns from`）

……所有这些情况都将抛出清晰的错误提示，而不会产生错误的字节。

## 边缘情况修复（对比上游）

每个修复在 `test/__tests__/analyzer.test.ts` 中都有对应的回归测试：

| # | 以前会损坏的情况 |
| --- | --- |
| 1 | `import { pb as P }` —— 别名标记曾被忽略；字段被静默丢弃 |
| 2 | `interface Foo { x: pb<1, Wrapper<uint_32>> }` —— typeName 曾卡在 `"Wrapper"`，未对内部实例化进行单态化 |
| 3 | `interface Outer<U> { x: pb<1, Wrapper<U>> }` —— 外部单态化曾未重新实例化内部泛型 |
| 4 | 包装器绑定生成的虚拟 SourceFile 文本曾为空 → `getText()` 返回垃圾数据 |
| 5 | 跨文件转发的包装器（链式 → 导入的基类）曾无法被检测 |
| 6 | `matchForwardedKnownWrapper` 曾未传播 `typePattern` —— 链式调用曾将 `<X>` 视为编码类型，而不是 `Wrapper<X>` |
| 7 | 虚拟 SF 的 WeakMap 曾对 `analyzer.ts` 私有 → 替换器使用了错误的 SF |

此外，前述的构建时防线可确保未来的分析器漏洞会直接触发硬错误，而不是产生静默的编码错误。

## 脚本命令

```bash
pnpm --filter @snowluma/proton build     # 打包 src/index.ts → dist/index.js
pnpm --filter @snowluma/proton test      # 运行 vitest (95 个测试)
pnpm --filter @snowluma/proton typecheck # 运行 tsc --noEmit

```

## 目录结构

```text
src/
  ast/                分析器 + 类型追踪管道
    analyzer.ts        单次遍历的消息 + 调用位置收集
    collector.ts       interface → ProtobufField/GenericFieldTemplate
    monomorphizer.ts   泛型实例化 → 具体 ProtobufMessage
    import-resolver.ts 跨文件定义 + 包装器解析
    callsite.ts        匹配 protobuf_encode/decode 调用
    static-wrapper.ts  静态方法包装器检测 (AST)
    utils.ts           名称解析 + 虚拟 SF 追踪
    dependency-graph.ts 拓扑排序 + 可达性
    types.ts           共享的 Schema 类型
  codegen/            内联传输格式发射器
    subclass-override.ts 每个子类重写的代码生成
  typecheck/          基于 TypeChecker 的管道（用于子类重写）
    program-cache.ts   延迟加载的 ts.Program，以 tsconfig 为键
    subclass-wrapper.ts extends 链遍历 + 类型参数解析
    file-pipeline.ts   插件 transform() 使用的单文件胶水层
  transform/          Vite 插件字符串编辑
  index.ts            插件入口 (./vite)
  runtime.ts          运行时桩代码 (.)

protobuf.d.ts         公共类型 (pb<>, pb_repeated<>, 原生别名)
test/                 vitest 测试套件 (包含分析器 + 跨文件 + 插件 + 子类包装器)

```
