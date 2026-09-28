/**
 * Search surface.
 *
 * `globalSearch` is the only entry point. Per-entity search already exists inside
 * each module's list use-case (`listStudents({ q })`, `listLeads({ q })`), and this
 * is deliberately NOT a second implementation of those: it answers the command-bar
 * question -- "find me this thing, whatever kind of thing it is" -- and returns
 * links rather than records.
 */

export {
  globalSearch,
  MATCH_RANK,
  SEARCH_HIT_TYPES,
  SEARCH_MIN_QUERY_LENGTH,
  type GlobalSearchInput,
  type GlobalSearchResult,
  type SearchHit,
  type SearchHitType,
} from './global';
