interface Inner {
    value: pb<1, uint_32>;
}

interface Outer {
    inner: pb<1, Inner>;
}
