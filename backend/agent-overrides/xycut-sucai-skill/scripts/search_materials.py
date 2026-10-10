from __future__ import annotations

import argparse
import json
from pathlib import Path

from common import connect_db, default_db_path, init_schema, parse_vector, read_json, search_materials


def load_query_embedding(args: argparse.Namespace):
    if args.query_embedding_file:
        return parse_vector(read_json(Path(args.query_embedding_file).expanduser().resolve()))
    if args.query_embedding_json:
        return parse_vector(args.query_embedding_json)
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description="Search material candidates by keyword and optional query embedding.")
    parser.add_argument("--db", default=str(default_db_path()), help="SQLite DB path.")
    parser.add_argument("--library-id", help="Filter by library id.")
    parser.add_argument("--collection-id", help="Filter by collection id, including descendants.")
    parser.add_argument("--query", default="", help="Natural language search query.")
    parser.add_argument("--keywords", default="", help="Comma separated extra keywords.")
    parser.add_argument("--query-embedding-json", help="Query embedding JSON array.")
    parser.add_argument("--query-embedding-file", help="File containing query embedding array or object.")
    parser.add_argument("--top-k", type=int, default=20, help="Max candidates.")
    parser.add_argument("--min-quality", type=float, default=0.35, help="Minimum material/segment quality score; use 0 to include all analyzed items.")
    parser.add_argument("--include-pending", action="store_true", help="Include materials not yet analyzed.")
    args = parser.parse_args()

    try:
        db_path = Path(args.db).expanduser().resolve()
        keywords = [item.strip() for item in args.keywords.split(",") if item.strip()]
        query_embedding = load_query_embedding(args)
        with connect_db(db_path) as conn:
            init_schema(conn)
            candidates = search_materials(
                conn,
                library_id=args.library_id,
                collection_id=args.collection_id,
                query=args.query,
                keywords=keywords,
                query_embedding=query_embedding,
                limit=args.top_k,
                include_pending=args.include_pending,
                min_quality=max(0.0, min(1.0, args.min_quality)),
            )
        print(
            json.dumps(
                {
                    "ok": True,
                    "db_path": str(db_path),
                    "query": args.query,
                    "keywords": keywords,
                    "used_vector": bool(query_embedding),
                    "count": len(candidates),
                    "candidates": candidates,
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False, indent=2))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
