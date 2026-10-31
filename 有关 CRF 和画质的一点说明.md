我们当前的这个 CRF 档位的选择其实和小丸工具箱里的那个可能差不多，而它那里面介绍的是：

> CRF中的质量的范围可以是1.0 - 51.0。一般设置21-25之间就可以，此值越大码率越低。 21可以压制出高码率。网络播放则设为24即可。

不过要考虑到它那里是 H264，而我们这里使用的是更高效的编码H265。

一个常见的经验参考是：

x264 CRF 23 ≈ x265 CRF 28

两者通常被视为相近的默认画质档位。实际上，x264 的默认值就是 23，而 x265 的默认值是 28。[Understanding Rate Control Modes (x264, x265, vpx)](https://slhck.info/video/2017/03/01/rate-control.html?utm_source=chatgpt.com)

不过，HandBrake 官方给出的 1080p 建议范围是 RF 20–24（适用于 x264 和 x265），并特别强调两者的数值不能直接比较。[HandBrake Documentation — Adjusting quality](https://handbrake.fr/docs/en/latest/workflow/adjust-quality.html?utm_source=chatgpt.com)

所以说好像其实 CRF 设置 21 就已经够清晰了？



然后我们一般压缩的都是 4K 60fps 的手机实拍视频，gpt 推荐 x265 CRF 20–22，首选 CRF 21。

> 实际上，4K 视频通常反而能容忍稍高一些的 CRF。HandBrake 官方推荐的 4K x265 常规画质范围是 RF 22–28，比 1080p 的 20–24 更高。这是因为高分辨率提供了更多细节，轻微损失通常不那么容易被察觉。