import type ts from 'typescript';
import { fail } from '../source/context.js';
import {
    PRIMITIVE_TYPE_MAP,
    WireType,
    type MessageRegistry,
    type ProtobufField,
} from '../codegen/model.js';
import type { TypeValue } from './types.js';

export class MessageBuilder {
    readonly registry: MessageRegistry = new Map();
    private readonly messageNames = new Map<string, string>();
    private readonly nameOwners = new Map<string, string>();

    build(type: TypeValue, node: ts.Node): string {
        if (type.dynamic) {
            fail(
                node,
                `Cannot statically resolve protobuf type ${type.name}. Supply concrete generic arguments at its call site.`,
            );
        }

        if (type.kind !== 'object' || !type.fields) {
            fail(node, `Expected a protobuf message, received ${type.name}.`);
        }

        const cached = this.messageNames.get(type.key);

        if (cached) {
            return cached;
        }

        let name = type.name.replace(/[^\p{ID_Continue}$]/gu, '_');

        if (!/^[\p{ID_Start}_$]/u.test(name)) {
            name = '_' + name;
        }

        if (this.nameOwners.has(name) && this.nameOwners.get(name) !== type.key) {
            let hash = 2166136261;

            for (const char of type.key) {
                hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
            }

            name += '_' + (hash >>> 0).toString(36);
        }

        this.nameOwners.set(name, type.key);
        this.messageNames.set(type.key, name);
        const fields: ProtobufField[] = [];
        this.registry.set(name, { name, fields });
        const numbers = new Set<number>();

        for (const [fieldName, property] of type.fields) {
            let marker = property.type;
            let optional = property.optional;

            if (marker.kind === 'union') {
                optional ||= marker.values!.some((item) => item.kind === 'null');
                const members = marker.values!.filter((item) => item.kind !== 'null');

                if (members.length !== 1) {
                    fail(property.node, `Ambiguous protobuf union on field ${fieldName}.`);
                }

                marker = members[0];
            }

            if (marker.kind !== 'marker') {
                fail(
                    property.node,
                    `Field ${fieldName} must use pb<N, T>, pb_optional<N, T> or pb_repeated<N, T>.`,
                );
            }

            const number = marker.fieldNumber!;

            if (
                !Number.isInteger(number) ||
                number < 1 ||
                number > 536870911 ||
                (number >= 19000 && number <= 19999)
            ) {
                fail(property.node, `Invalid or reserved protobuf field number ${number}.`);
            }

            if (numbers.has(number)) {
                fail(property.node, `Duplicate protobuf field number ${number}.`);
            }

            numbers.add(number);
            let payload = marker.values![0];

            if (payload.kind === 'marker') {
                payload = payload.values![0];
            }

            if (payload.kind === 'union') {
                optional ||= payload.values!.some((item) => item.kind === 'null');
                const members = payload.values!.filter((item) => item.kind !== 'null');

                if (members.length !== 1) {
                    fail(property.node, `Ambiguous protobuf union on field ${fieldName}.`);
                }

                payload = members[0];
            }

            const repeated = marker.repeated || payload.kind === 'array';

            if (payload.kind === 'array') {
                payload = payload.values![0];
            }

            const isMessage = payload.kind === 'object';
            const typeName = isMessage ? this.build(payload, property.node) : payload.name;
            const primitive = PRIMITIVE_TYPE_MAP[typeName];

            if (!isMessage && !primitive) {
                fail(
                    property.node,
                    `Unsupported protobuf field type ${typeName}. Use an explicit protobuf scalar type.`,
                );
            }

            fields.push({
                name: fieldName,
                fieldNumber: number,
                typeName,
                wireType: isMessage ? WireType.LengthDelim : primitive.wireType,
                isMessage,
                isRepeated: !!repeated,
                isOptional: optional,
                explicitPresence: marker.explicitPresence,
            });
        }

        fields.sort((a, b) => a.fieldNumber - b.fieldNumber);
        return name;
    }
}
