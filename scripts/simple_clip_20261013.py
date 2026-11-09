import os
import sys

CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
SKILL_ROOT = os.environ.get('JY_SKILL_ROOT', '/Users/sunmingyuan/.codex/skills/jianying-editor')
SCRIPTS_PATH = os.path.join(SKILL_ROOT, 'scripts')
if SCRIPTS_PATH not in sys.path:
    sys.path.insert(0, SCRIPTS_PATH)
from jy_wrapper import JyProject

VIDEO = '/Users/sunmingyuan/Desktop/AI短剧.mov'
PROJECT_NAME = 'AI短剧_前10秒简单剪辑_20261013'

if not os.path.isfile(VIDEO):
    raise FileNotFoundError(VIDEO)

project = JyProject(project_name=PROJECT_NAME, width=1080, height=1920, overwrite=True)
project.add_media_safe(VIDEO, start_time='0s', duration='10s', track_name='VideoTrack')
project.save()
print({'ok': True, 'project': PROJECT_NAME, 'source': VIDEO, 'clip_start': 0, 'clip_duration': 10})
