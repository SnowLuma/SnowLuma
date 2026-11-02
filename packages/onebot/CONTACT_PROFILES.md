# Contact profiles

`get_friend_list` and `get_friends_with_category` preserve their existing result
shapes and add optional public profile fields to each friend. By default they
only read the paginated roster: they do not issue a profile request for every
friend. Both accept `with_profile: true` to explicitly query additional details.
Large lists may require a longer client timeout.

Explicit enrichment uses a five-minute cache belonging to the current account,
deduplicates simultaneous queries and limits aggregate profile concurrency to
four. Values already supplied by the roster take precedence, including empty
strings, zero and false. An enrichment failure fails the action after draining
the current batch; it is logged, is not cached and is not automatically retried.
A later call may retry it. The ordinary flat list retains its existing logged
fallback to cached friends when the roster cannot be refreshed.

Friend rows contain `user_id`, `nickname`, `remark`, and `category_id` when
available. Public fields also appear in `get_stranger_info` when QQ supplies them:

| Fields | Meaning |
| --- | --- |
| `long_nick`, `sex`, `age`, `level` | Signature, gender, age and QQ level |
| `birthday_year`, `birthday_month`, `birthday_day` | Birthday; a hidden year is omitted |
| `phone_num`, `email` | Contact details made available by the profile |
| `country`, `province`, `city`, `college` | Location and school |
| `is_qq_vip`, `is_vip`, `is_years_vip`, `vip_level` | Ordinary membership, super membership (existing meaning of `is_vip`), annual membership and level |
| `privilege_icons` | `jump_url` if supplied, plus `open` and `closed` icon lists |

Each privilege entry may contain `type`, `level`, `flag`, `is_big`, `jump_url`,
`icon_url` and `deluxe_icon_url`. The two icon URLs can coexist. Flags retain
their server values; they are not guessed to mean annual or premium membership.
Local downloaded icon paths are not part of the response.

Missing data is omitted rather than replaced with false, zero or an empty list.
An explicitly returned empty icon-list body produces `open: [], closed: []`;
unavailable icon data omits `privilege_icons`. Existing required stranger fields
and aliases retain their earlier defaults. Malformed optional birthdays are
logged without recording their values; malformed text or privilege payloads
fail decoding.

SDK calls keep the existing options argument:

```ts
const friends = await client.getFriendList({ withProfile: true, timeoutMs: 120_000 });
const categories = await client.call('get_friends_with_category', { with_profile: true });
```

The exported `FriendInfo`, `StrangerInfo`, `PublicProfileFields` and
`ProfilePrivilege` types describe these fields. Returned availability depends
on QQ and the account's access; requesting enrichment does not guarantee every
field is present.
