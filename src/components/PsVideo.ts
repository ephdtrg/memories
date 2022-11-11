import PhotoSwipe from "photoswipe";
import { generateUrl } from "@nextcloud/router";
import { loadState } from "@nextcloud/initial-state";
import axios from "@nextcloud/axios";

globalThis.muxjs = require("mux.js");
globalThis.shaka = require("shaka-player/dist/shaka-player.ui.js");
const shaka = globalThis.shaka;
shaka.polyfill.installAll();

const config_noTranscode = loadState(
  "memories",
  "notranscode",
  <string>"UNSET"
) as boolean | string;

// Generate client id for this instance
// Does not need to be cryptographically secure
const clientId = Math.random().toString(36).substring(2, 15).padEnd(12, "0");

/**
 * Check if slide has video content
 *
 * @param {Slide|Content} content Slide or Content object
 * @returns Boolean
 */
function isVideoContent(content): boolean {
  return content?.data?.type === "video";
}

class VideoContentSetup {
  constructor(lightbox: PhotoSwipe, private options) {
    this.initLightboxEvents(lightbox);
    lightbox.on("init", () => {
      this.initPswpEvents(lightbox);
    });
  }

  initLightboxEvents(lightbox: PhotoSwipe) {
    lightbox.on("contentLoad", this.onContentLoad.bind(this));
    lightbox.on("contentDestroy", this.onContentDestroy.bind(this));
    lightbox.on("contentActivate", this.onContentActivate.bind(this));
    lightbox.on("contentDeactivate", this.onContentDeactivate.bind(this));
    lightbox.on("contentAppend", this.onContentAppend.bind(this));
    lightbox.on("contentResize", this.onContentResize.bind(this));

    lightbox.addFilter(
      "isKeepingPlaceholder",
      this.isKeepingPlaceholder.bind(this)
    );
    lightbox.addFilter("isContentZoomable", this.isContentZoomable.bind(this));
    lightbox.addFilter(
      "useContentPlaceholder",
      this.useContentPlaceholder.bind(this)
    );

    lightbox.addFilter("domItemData", (itemData, element, linkEl) => {
      return itemData;
    });
  }

  initPswpEvents(pswp: PhotoSwipe) {
    // Prevent draggin when pointer is in bottom part of the video
    // todo: add option for this
    pswp.on("pointerDown", (e) => {
      const slide = pswp.currSlide;
      if (isVideoContent(slide) && this.options.preventDragOffset) {
        const origEvent = e.originalEvent;
        if (origEvent.type === "pointerdown") {
          // Check if directly over the shaka control bar
          const elems = document.elementsFromPoint(
            origEvent.clientX,
            origEvent.clientY
          );
          if (
            elems.some((el) => el.classList.contains("shaka-no-propagation"))
          ) {
            e.preventDefault();
            return;
          }

          const videoHeight = Math.ceil(slide.height * slide.currZoomLevel);
          const verticalEnding = videoHeight + slide.bounds.center.y;
          const pointerYPos = origEvent.pageY - pswp.offset.y;
          if (
            pointerYPos > verticalEnding - this.options.preventDragOffset &&
            pointerYPos < verticalEnding
          ) {
            e.preventDefault();
          }
        }
      }
    });

    // do not append video on nearby slides
    pswp.on("appendHeavy", (e) => {
      if (isVideoContent(e.slide)) {
        const content = <any>e.slide.content;

        if (!e.slide.isActive) {
          e.preventDefault();
        } else if (content.videoElement) {
          this.initShaka(content);
        }
      }
    });

    pswp.on("close", () => {
      if (isVideoContent(pswp.currSlide.content)) {
        // Switch from zoom to fade closing transition,
        // as zoom transition is choppy for videos
        if (
          !pswp.options.showHideAnimationType ||
          pswp.options.showHideAnimationType === "zoom"
        ) {
          pswp.options.showHideAnimationType = "fade";
        }

        // pause video when closing
        this.destroyShaka(pswp.currSlide.content);
      }
    });
  }

  initShaka(content: any) {
    if (!isVideoContent(content) || content.shaka) {
      return;
    }

    // Create element
    content.videoElement = document.createElement("video");
    content.videoElement.setAttribute("poster", content.data.msrc);
    if (this.options.videoAttributes) {
      for (let key in this.options.videoAttributes) {
        content.videoElement.setAttribute(
          key,
          this.options.videoAttributes[key] || ""
        );
      }
    }
    content.element.appendChild(content.videoElement);

    const fileid = content.data.photo.fileid;

    // Create hls sources if enabled
    const baseUrl = generateUrl(
      `/apps/memories/api/video/transcode/${clientId}/${fileid}`
    );

    // Get source url
    let src: string;
    if (config_noTranscode) {
      src = content.data.src;
    } else {
      src = `${baseUrl}/index.m3u8`;
    }

    // Create player
    content.shaka = new shaka.Player(content.videoElement);
    content.shaka.configure({
      streaming: {
        bufferingGoal: 60,
      },
    });

    const ui = new shaka.ui.Overlay(
      content.shaka,
      content.element,
      content.videoElement
    );
    ui.configure({
      overflowMenuButtons: [
        "cast",
        "airplay",
        "playback_rate",
        "quality",
        "statistics",
      ],
    });
    ui.getControls();

    // Prevent big buttons
    content.element
      .querySelectorAll("button")
      .forEach((el: HTMLButtonElement) => {
        el.classList.add("button-vue");
      });

    // Fallback to original
    content.shaka.load(src).catch((err: any) => {
      if (src.includes("m3u8")) {
        console.error("Shaka: HLS stream could not be opened.");
        src = content.data.src;
        content.shaka.load(src);
        this.updateRotation(content, 0);
      }
    });

    // Get correct orientation
    axios
      .get<any>(
        generateUrl("/apps/memories/api/image/info/{id}", {
          id: content.data.photo.fileid,
        })
      )
      .then((response) => {
        content.data.exif = response.data?.exif;
        this.updateRotation(content);
      });
  }

  destroyShaka(content: any) {
    if (isVideoContent(content) && content.shaka) {
      content.shaka.unload();
      content.shaka.destroy();
      content.shaka = null;
      console.log("Shaka: Disposed");

      const elem: HTMLDivElement = content.element;
      while (elem.lastElementChild) {
        elem.removeChild(elem.lastElementChild);
      }
      content.videoElement = null;
    }
  }

  onContentDestroy({ content }) {
    this.destroyShaka(content);
  }

  onContentResize(e) {
    if (isVideoContent(e.content)) {
      e.preventDefault();

      const width = e.width;
      const height = e.height;
      const content = e.content;

      if (content.element) {
        content.element.style.width = width + "px";
        content.element.style.height = height + "px";
      }

      if (content.slide && content.slide.placeholder) {
        // override placeholder size, so it more accurately matches the video
        const placeholderElStyle = content.slide.placeholder.element.style;
        placeholderElStyle.transform = "none";
        placeholderElStyle.width = width + "px";
        placeholderElStyle.height = height + "px";
      }

      this.updateRotation(content);
    }
  }

  updateRotation(content: any, val?: number) {
    if (!content.videoElement || !content.shaka) {
      return;
    }

    const rotation = val ?? Number(content.data.exif?.Rotation);
    if (rotation) {
      let transform = `rotate(${rotation}deg)`;

      if (rotation === 90 || rotation === 270) {
        content.videoElement.style.width = content.element.style.height;
        content.videoElement.style.height = content.element.style.width;

        transform = `translateY(-${content.element.style.width}) ${transform}`;
        content.videoElement.style.transformOrigin = "bottom left";
      }

      content.videoElement.style.transform = transform;
    } else {
      content.videoElement.style.transform = "none";
      content.videoElement.style.width = "100%";
      content.videoElement.style.height = "100%";
    }
  }

  isKeepingPlaceholder(isZoomable, content) {
    if (isVideoContent(content)) {
      return false;
    }
    return isZoomable;
  }

  isContentZoomable(isZoomable, content) {
    if (isVideoContent(content)) {
      return false;
    }
    return isZoomable;
  }

  onContentActivate({ content }) {
    this.initShaka(content);
  }

  onContentDeactivate({ content }) {
    this.destroyShaka(content);
  }

  onContentAppend(e) {
    if (isVideoContent(e.content)) {
      e.preventDefault();
      e.content.isAttached = true;
      e.content.appendImage();
    }
  }

  onContentLoad(e) {
    const content = e.content; // todo: videocontent

    if (!isVideoContent(e.content)) {
      return;
    }

    // stop default content load
    e.preventDefault();

    if (content.element) {
      return;
    }

    if (config_noTranscode === "UNSET") {
      content.element = document.createElement("div");
      content.element.innerHTML =
        "Video not configured. Run occ memories:video-setup";
      content.element.style.color = "red";
      content.element.style.display = "flex";
      content.element.style.alignItems = "center";
      content.element.style.justifyContent = "center";
      content.onLoaded();
      return;
    }

    content.state = "loading";
    content.type = "video"; // TODO: move this to pswp core?

    content.element = document.createElement("div");
    content.element.style.position = "absolute";
    content.element.style.left = 0;
    content.element.style.top = 0;
    content.element.style.width = "100%";
    content.element.style.height = "100%";

    content.onLoaded();
  }

  useContentPlaceholder(usePlaceholder, content) {
    if (isVideoContent(content)) {
      return true;
    }
    return usePlaceholder;
  }
}

export default VideoContentSetup;
