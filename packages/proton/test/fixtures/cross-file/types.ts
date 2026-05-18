interface UserMsg {
    id: pb<1, uint_32>;
    name: pb<2, string>;
}

export type { UserMsg };
