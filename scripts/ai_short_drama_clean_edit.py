import os
import sys
from pathlib import Path

CURRENT_DIR = Path(__file__).resolve().parent.parent
SKILL_ROOT = Path(os.environ.get("JY_SKILL_ROOT", "/Users/sunmingyuan/.codex/skills/jianying-editor")).resolve()
sys.path.insert(0, str(SKILL_ROOT / "scripts"))

from jy_wrapper import JyProject

VIDEO = CURRENT_DIR / ".test-data/video-edit-20261012/AI短剧_portrait_compatible.mp4"
DRAFT_ROOT = Path("/Users/sunmingyuan/Movies/JianyingPro/User Data/Projects/com.lveditor.draft")
PROJECT_NAME = "AI短剧_AI口播清洁剪辑_20261012"

# 来源于本地 ffmpeg silencedetect；只移除约 0.3 秒的明显静音，不切断句子。
CUTS = [
    (1.000, 26.061),
    (26.391, 78.558),
    (78.879, 116.822),
    (117.161, 147.363),
    (147.674, 157.508),
    (157.841, 180.193),
    (180.502, 187.401),
    (187.755, 235.104),
    (235.421, 246.000),
]

if not VIDEO.exists():
    raise FileNotFoundError(VIDEO)
if not DRAFT_ROOT.is_dir():
    raise FileNotFoundError(DRAFT_ROOT)

project = JyProject(project_name=PROJECT_NAME, width=1080, height=1920, drafts_root=str(DRAFT_ROOT), overwrite=True)
timeline_start = 0.0
for source_start, source_end in CUTS:
    duration = source_end - source_start
    project.add_clip(
        str(VIDEO),
        source_start=f"{source_start:.3f}s",
        duration=f"{duration:.3f}s",
        target_start=f"{timeline_start:.3f}s",
        track_name="VideoTrack",
    )
    timeline_start += duration

project.add_text_simple("AI短剧", start_time="0s", duration="2.5s", track_name="Title")
project.add_text_simple("完", start_time=f"{max(0, timeline_start - 2.5):.3f}s", duration="2.5s", track_name="EndTitle")
save_result = project.save()

tracks = []
track_values = project.script.tracks.values() if isinstance(project.script.tracks, dict) else project.script.tracks
for track in track_values:
    tracks.append({"name": getattr(track, "name", ""), "segments": len(getattr(track, "segments", []))})
print({
    "project_name": PROJECT_NAME,
    "draft_path": save_result["draft_path"],
    "timeline_duration_seconds": round(timeline_start, 3),
    "removed_silence_seconds": round(247 - timeline_start, 3),
    "video_segments": len(CUTS),
    "tracks": tracks,
    "save": save_result["status"],
})
