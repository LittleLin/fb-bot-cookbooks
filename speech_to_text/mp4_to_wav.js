var ffmpeg = require('fluent-ffmpeg');

ffmpeg('./material/source.mp4').output('./material/output.wav').run();
