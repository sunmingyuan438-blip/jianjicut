import os
import sys
from pathlib import Path

CURRENT_DIR = Path(__file__).resolve().parent.parent
SKILL_ROOT = Path(os.environ.get("JY_SKILL_ROOT", "/Users/sunmingyuan/.codex/skills/jianying-editor")).resolve()
sys.path.insert(0, str(SKILL_ROOT / "scripts"))

from jy_wrapper import JyProject

VIDEO = Path("/Users/sunmingyuan/Desktop/AI短剧.mov")
DRAFT_ROOT = Path("/Users/sunmingyuan/Movies/JianyingPro/User Data/Projects/com.lveditor.draft")
PROJECT_NAME = "AI短剧_基础剪辑_20261012"

if not VIDEO.exists():
    raise FileNotFoundError(VIDEO)
if not DRAFT_ROOT.is_dir():
    raise FileNotFoundError(DRAFT_ROOT)

project = JyProject(
    project_name=PROJECT_NAME,
    width=1080,
    height=1920,
    drafts_root=str(DRAFT_ROOT),
    overwrite=True,
)

# 保留原视频内容，去掉首尾各 1 秒，素材会复制进草稿目录。
video_segment = project.add_clip(
    str(VIDEO),
    source_start="1s",
    duration="245s",
    target_start="0s",
    track_name="VideoTrack",
)
if video_segment is None:
    raise RuntimeError("视频素材导入失败")

project.add_text_simple("AI短剧", start_time="0s", duration="3s", track_name="Title")
project.add_text_simple("完", start_time="242s", duration="3s", track_name="EndTitle")

save_result = project.save()

tracks = []
track_values = project.script.tracks.values() if isinstance(project.script.tracks, dict) else project.script.tracks
for track in track_values:
    tracks.append({
        "name": getattr(track, "name", ""),
        "type": str(getattr(getattr(track, "type", None), "value", getattr(track, "type", ""))),
        "segments": len(getattr(track, "segments", [])),
    })

print({
    "project_name": PROJECT_NAME,
    "draft_path": save_result["draft_path"],
    "source": str(VIDEO),
    "source_duration_seconds": 247,
    "timeline_duration_seconds": 245,
    "trim": {"source_start_seconds": 1, "head_trim_seconds": 1, "tail_trim_seconds": 1},
    "tracks": tracks,
    "save": save_result["status"],
})
