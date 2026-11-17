export type MicrophoneLease = {
  stream: MediaStream;
  release(): void;
};

type RequestMicrophone = (constraints: MediaStreamConstraints) => Promise<MediaStream>;

export class SharedMicrophone {
  private stream?: MediaStream;
  private pending?: Promise<MediaStream>;

  constructor(private readonly request: RequestMicrophone = (constraints) => navigator.mediaDevices.getUserMedia(constraints)) {}

  async acquire(): Promise<MicrophoneLease> {
    const stream = await this.liveStream();
    for (const track of stream.getAudioTracks()) track.enabled = true;
    return {
      stream,
      release: () => {
        for (const track of stream.getAudioTracks()) track.enabled = false;
      },
    };
  }

  private async liveStream(): Promise<MediaStream> {
    if (this.stream?.active) return this.stream;

    this.pending ??= this.request({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      video: false,
    }).then((stream) => {
      this.stream = stream;
      return stream;
    }).finally(() => {
      this.pending = undefined;
    });
    return await this.pending;
  }
}
