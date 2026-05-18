interface UserProfile {
    id: pb<1, uint_32>;
    username: pb<2, string>;
    active: pb<3, bool>;
}
