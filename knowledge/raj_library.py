"""The reader app exposes only already indexed Raj Shamani videos."""
import os

from .channel_library import ChannelLibrary

CHANNEL_ID = "UCzwCEE_PchiBULMnAJqhGVg"


class RajShamaniLibrary(ChannelLibrary):
    read_only = True
    answer_repairs = 1
    answer_strategy = 'video_guide'
    allow_closest = False

    def search(self, question, source_id=None, progress=None):
        from .caption_retrieval import retrieve
        return retrieve(self, question, source_id, progress)

    def _adopt_trial(self):
        # Browsing an existing collection must not adopt or queue new documents.
        pass

    def start(self):
        # No discovery, caption downloads, or indexing worker in the reader app.
        pass

    def step(self):
        return False

    def ready_videos(self):
        return self.store.rows(
            "SELECT v.*,v.state AS status,v.segments AS chunks FROM videos v "
            "JOIN channel_videos cv ON cv.video_id=v.id "
            "WHERE cv.channel_id=? AND v.state='ready' ORDER BY v.updated_at DESC,v.id",
            (CHANNEL_ID,))

    def page(self, offset=0, *, status=""):
        if status not in {"", "ready"}:
            raise ValueError("Only indexed Raj Shamani videos are available.")
        if not isinstance(offset, int) or not 0 <= offset <= 1_000_000:
            raise ValueError("Invalid page offset.")
        return self.ready_videos()[offset:offset + 50]

    def status(self):
        videos = self.ready_videos()
        return {"backend": "supermemory", "read_only": True,
                "library_title": "Raj Shamani", "channels": [],
                "counts": {"ready": len(videos)}, "total": len(videos),
                "sources": videos[:50], "worker_running": False,
                "credentials": {"indexing": bool(os.getenv("SUPERMEMORY_API_KEY")),
                                "answers": bool(os.getenv("OPENAI_API_KEY"))},
                "answer_model": self.llm.model_name}

    def _reject_import(self, *args, **kwargs):
        raise ValueError("This library contains only indexed Raj Shamani videos. Imports are disabled.")

    preview = add_channel = start_ingestion = action = _reject_import
