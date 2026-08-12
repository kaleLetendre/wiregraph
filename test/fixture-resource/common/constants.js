// The ONE shared constants module (join mechanism: a shared module both sides
// import). The join key is the CONSTANT NAME — never the literal path, because
// wiregraph is deliberately literal-blind.
export const GAME_STATE_PATH = '/var/run/game/state.json';
export const LOCK_FILE_PATH = '/var/run/game/world.lock';
export const CACHE_INDEX_PATH = '/var/run/game/cache.idx';
