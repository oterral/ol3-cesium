goog.provide('olcs.OLCesium');

goog.require('goog.async.AnimationDelay');
goog.require('goog.async.Delay');
goog.require('olcs.AutoRenderLoop');
goog.require('olcs.Camera');
goog.require('olcs.RasterSynchronizer');
goog.require('olcs.VectorSynchronizer');



/**
 * @param {!olcsx.OLCesiumOptions} options Options.
 * @constructor
 * @api
 * @struct
 */
olcs.OLCesium = function(options) {

  /**
   * @type {olcs.AutoRenderLoop}
   * @private
   */
  this.autoRenderLoop_ = null;

  /**
   * @type {!ol.Map}
   * @private
   */
  this.map_ = options.map;

  /**
   * No change of the view projection.
   * @private
   */
  this.to4326Transform_ = ol.proj.getTransform(this.map_.getView().getProjection(), 'EPSG:4326');

  /**
   * @type {number}
   * @private
   */
  this.resolutionScale_ = 1.0;

  /**
   * @type {number}
   * @private
   */
  this.canvasClientWidth_ = 0.0;

  /**
   * @type {number}
   * @private
   */
  this.canvasClientHeight_ = 0.0;

  /**
   * @type {boolean}
   * @private
   */
  this.resolutionScaleChanged_ = true; // force resize

  var fillArea = 'position:absolute;top:0;left:0;width:100%;height:100%;';

  /**
   * @type {!Element}
   * @private
   */
  this.container_ = document.createElement('DIV');
  var containerAttribute = document.createAttribute('style');
  containerAttribute.value = fillArea + 'visibility:hidden;';
  this.container_.setAttributeNode(containerAttribute);

  var targetElement = options.target || null;
  if (targetElement) {
    if (typeof targetElement === 'string') {
      targetElement = document.getElementById(targetElement);
    }
    targetElement.appendChild(this.container_);
  } else {
    var oc = this.map_.getViewport().querySelector('.ol-overlaycontainer');
    if (oc && oc.parentNode) {
      oc.parentNode.insertBefore(this.container_, oc);
    }
  }

  /**
   * Whether the Cesium container is placed over the ol map.
   * @type {boolean}
   * @private
   */
  this.isOverMap_ = !goog.isDefAndNotNull(targetElement);

  /**
   * @type {!HTMLCanvasElement}
   * @private
   */
  this.canvas_ = /** @type {!HTMLCanvasElement} */ (
      document.createElement('CANVAS'));
  var canvasAttribute = document.createAttribute('style');
  canvasAttribute.value = fillArea;
  this.canvas_.setAttributeNode(canvasAttribute);

  if (olcs.supportsImageRenderingPixelated()) {
    // non standard CSS4
    this.canvas_.style['imageRendering'] = olcs.imageRenderingValue();
  }

  this.canvas_.oncontextmenu = function() { return false; };
  this.canvas_.onselectstart = function() { return false; };

  this.container_.appendChild(this.canvas_);

  /**
   * @type {boolean}
   * @private
   */
  this.enabled_ = false;

  /**
   * @type {!Array.<ol.interaction.Interaction>}
   * @private
   */
  this.pausedInteractions_ = [];

  /**
   * @type {?ol.layer.Group}
   * @private
   */
  this.hiddenRootGroup_ = null;

  var sceneOptions = options.sceneOptions !== undefined ? options.sceneOptions :
      /** @type {Cesium.SceneOptions} */ ({});
  sceneOptions.canvas = this.canvas_;
  sceneOptions.scene3DOnly = true;

  /**
   * @type {!Cesium.Scene}
   * @private
   */
  this.scene_ = new Cesium.Scene(sceneOptions);

  var sscc = this.scene_.screenSpaceCameraController;

  sscc.tiltEventTypes.push({
    'eventType': Cesium.CameraEventType.LEFT_DRAG,
    'modifier': Cesium.KeyboardEventModifier.SHIFT
  });

  sscc.tiltEventTypes.push({
    'eventType': Cesium.CameraEventType.LEFT_DRAG,
    'modifier': Cesium.KeyboardEventModifier.ALT
  });

  sscc.enableLook = false;

  this.scene_.camera.constrainedAxis = Cesium.Cartesian3.UNIT_Z;

  /**
   * @type {!olcs.Camera}
   * @private
   */
  this.camera_ = new olcs.Camera(this.scene_, this.map_);

  /**
   * @type {!Cesium.Globe}
   * @private
   */
  this.globe_ = new Cesium.Globe(Cesium.Ellipsoid.WGS84);
  this.globe_.baseColor = Cesium.Color.WHITE;
  this.scene_.globe = this.globe_;
  this.scene_.skyAtmosphere = new Cesium.SkyAtmosphere();

  this.dataSourceCollection_ = new Cesium.DataSourceCollection();
  this.dataSourceDisplay_ = new Cesium.DataSourceDisplay({
    scene: this.scene_,
    dataSourceCollection: this.dataSourceCollection_
  });

  var synchronizers = goog.isDef(options.createSynchronizers) ?
      options.createSynchronizers(this.map_, this.scene_, this.dataSourceCollection_) : [
        new olcs.RasterSynchronizer(this.map_, this.scene_),
        new olcs.VectorSynchronizer(this.map_, this.scene_)
      ];

  // Assures correct canvas size after initialisation
  this.handleResize_();

  for (var i = synchronizers.length - 1; i >= 0; --i) {
    synchronizers[i].synchronize();
  }

  if (this.isOverMap_) {
    // if in "stacked mode", hide everything except canvas (including credits)
    var credits = this.canvas_.nextElementSibling;
    if (goog.isDefAndNotNull(credits)) {
      credits.style.display = 'none';
    }
  }

  /**
   * Delay to render the Cesium scene.
   * @type {goog.async.AnimationDelay|goog.async.Delay}
   * @private
   */
  this.cesiumRenderingDelay_ = new goog.async.AnimationDelay(this.render_, undefined, this);

  /**
   * @private
   */
  this.blockCesiumRendering_ = false;

  /**
   * @type {ol.Feature}
   * @private
   */
  this.trackedFeature_ = null;

  /**
   * @type {Cesium.Entity}
   * @private
   */
  this.trackedEntity_ = null;

  /**
   * @type {Cesium.EntityView}
   * @private
   */
  this.entityView_ = null;

  /**
   * @type {boolean}
   * @private
   */
  this.needTrackedEntityUpdate_ = false;

  /**
   * @type {!Cesium.BoundingSphere}
   */
  this.boundingSphereScratch_ = new Cesium.BoundingSphere();

  var eventHelper = new Cesium.EventHelper();
  eventHelper.add(this.scene_.postRender, olcs.OLCesium.prototype.updateTrackedEntity_, this);
};


Object.defineProperties(olcs.OLCesium.prototype, {
  'trackedFeature': {
    'get': /** @this {olcs.OLCesium} */ function() {
      return this.trackedFeature_;
    },
    'set': /** @this {olcs.OLCesium} */ function(feature) {
      if (this.trackedFeature_ !== feature) {

        var scene = this.scene_;

        //Stop tracking
        if (!feature || !feature.getGeometry()) {
          this.needTrackedEntityUpdate_ = false;
          scene.screenSpaceCameraController.enableTilt = true;

          if (this.trackedEntity_) {
            this.dataSourceDisplay_.defaultDataSource.entities.remove(this.trackedEntity_);
          }
          this.trackedEntity_ = null;
          this.trackedFeature_ = null;
          this.entityView_ = null;
          scene.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
          return;
        }

        this.trackedFeature_ = feature;

        //We can't start tracking immediately, so we set a flag and start tracking
        //when the bounding sphere is ready (most likely next frame).
        this.needTrackedEntityUpdate_ = true;

        var to4326Transform = this.to4326Transform_;
        var toCesiumPosition = function() {
          var geometry = feature.getGeometry();
          goog.asserts.assertInstanceof(geometry, ol.geom.Point);
          var coo = geometry.getCoordinates();
          var coo4326 = to4326Transform(coo, undefined, coo.length);
          return olcs.core.ol4326CoordinateToCesiumCartesian(coo4326);
        };

        // Create an invisible point entity for tracking.
        // It is independant from the primitive/geometry created by the vector synchronizer.
        var options = {
          'position': new Cesium.CallbackProperty(function(time, result) {
            return toCesiumPosition();
          }, false),
          'point': {
            'pixelSize': 1,
            'color': Cesium.Color.TRANSPARENT
          }
        };

        this.trackedEntity_ = this.dataSourceDisplay_.defaultDataSource.entities.add(options);
      }
    }
  }
});


/**
 * Render the Cesium scene.
 * @param {number=} opt_time Timestamp from `getAnimationFrame`.
 * @private
 */
olcs.OLCesium.prototype.render_ = function(opt_time) {
  if (!this.blockCesiumRendering_) {
    var julianDate = Cesium.JulianDate.now();
    this.scene_.initializeFrame();
    this.handleResize_();
    this.dataSourceDisplay_.update(julianDate);

    // Update tracked entity
    if (this.entityView_) {
      var trackedEntity = this.trackedEntity_;
      var trackedState = this.dataSourceDisplay_.getBoundingSphere(trackedEntity, false, this.boundingSphereScratch_);
      if (trackedState === Cesium.BoundingSphereState.DONE) {
        this.boundingSphereScratch_.radius = 1; // a radius of 1 is enough for tracking points
        this.entityView_.update(julianDate, this.boundingSphereScratch_);
      }
    }

    this.scene_.render(julianDate);
    this.enabled_ && this.camera_.checkCameraChange();

    if (this.cesiumRenderingDelay_) {
      this.cesiumRenderingDelay_.start();
    }
  }
};


/**
 * @private
 */
olcs.OLCesium.prototype.updateTrackedEntity_ = function() {
  if (!this.needTrackedEntityUpdate_) {
    return;
  }

  var trackedEntity = this.trackedEntity_;
  var scene = this.scene_;

  var state = this.dataSourceDisplay_.getBoundingSphere(trackedEntity, false, this.boundingSphereScratch_);
  if (state === Cesium.BoundingSphereState.PENDING) {
    return;
  }

  scene.screenSpaceCameraController.enableTilt = false;

  var bs = state !== Cesium.BoundingSphereState.FAILED ? this.boundingSphereScratch_ : undefined;
  if (bs) {
    bs.radius = 1;
  }
  this.entityView_ = new Cesium.EntityView(trackedEntity, scene, scene.mapProjection.ellipsoid);
  this.entityView_.update(Cesium.JulianDate.now(), bs); // FIXME: have a global management of current time
  this.needTrackedEntityUpdate_ = false;
};


/**
 * @private
 */
olcs.OLCesium.prototype.handleResize_ = function() {
  var width = this.canvas_.clientWidth;
  var height = this.canvas_.clientHeight;

  if (width === 0 | height === 0) {
    // The canvas DOM element is not ready yet.
    return;
  }

  if (width === this.canvasClientWidth_ &&
      height === this.canvasClientHeight_ &&
      !this.resolutionScaleChanged_) {
    return;
  }

  var resolutionScale = this.resolutionScale_;
  if (!olcs.supportsImageRenderingPixelated()) {
    resolutionScale *= window.devicePixelRatio || 1.0;
  }
  this.resolutionScaleChanged_ = false;

  this.canvasClientWidth_ = width;
  this.canvasClientHeight_ = height;

  width *= resolutionScale;
  height *= resolutionScale;

  this.canvas_.width = width;
  this.canvas_.height = height;
  this.scene_.camera.frustum.aspectRatio = width / height;
};


/**
 * @return {!olcs.Camera}
 * @api
 */
olcs.OLCesium.prototype.getCamera = function() {
  return this.camera_;
};


/**
 * @return {!ol.Map}
 * @api
 */
olcs.OLCesium.prototype.getOlMap = function() {
  return this.map_;
};


/**
 * @return {!Cesium.Scene}
 * @api
 */
olcs.OLCesium.prototype.getCesiumScene = function() {
  return this.scene_;
};


/**
 * @return {!Cesium.DataSourceCollection}
 * @api
 */
olcs.OLCesium.prototype.getDataSources = function() {
  return this.dataSourceCollection_;
};


/**
 * @return {!Cesium.DataSourceDisplay}
 * @api
 */
olcs.OLCesium.prototype.getDataSourceDisplay = function() {
  return this.dataSourceDisplay_;
};


/**
 * @return {boolean}
 * @api
 */
olcs.OLCesium.prototype.getEnabled = function() {
  return this.enabled_;
};


/**
 * Enables/disables the Cesium.
 * This modifies the visibility style of the container element.
 * @param {boolean} enable
 * @api
 */
olcs.OLCesium.prototype.setEnabled = function(enable) {
  if (this.enabled_ === enable) {
    return;
  }
  this.enabled_ = enable;

  // some Cesium operations are operating with canvas.clientWidth,
  // so we can't remove it from DOM or even make display:none;
  this.container_.style.visibility = this.enabled_ ? 'visible' : 'hidden';
  var interactions;
  if (this.enabled_) {
    this.throwOnUnitializedMap_();
    if (this.isOverMap_) {
      interactions = this.map_.getInteractions();
      interactions.forEach(function(el, i, arr) {
        this.pausedInteractions_.push(el);
      }, this);
      interactions.clear();

      var rootGroup = this.map_.getLayerGroup();
      if (rootGroup.getVisible()) {
        this.hiddenRootGroup_ = rootGroup;
        this.hiddenRootGroup_.setVisible(false);
      }
    }
    this.camera_.readFromView();
    this.cesiumRenderingDelay_.start();
  } else {
    if (this.isOverMap_) {
      interactions = this.map_.getInteractions();
      this.pausedInteractions_.forEach(function(interaction) {
        interactions.push(interaction);
      });
      this.pausedInteractions_.length = 0;

      if (!goog.isNull(this.hiddenRootGroup_)) {
        this.hiddenRootGroup_.setVisible(true);
        this.hiddenRootGroup_ = null;
      }
    }

    this.camera_.updateView();
    this.cesiumRenderingDelay_.stop();
  }
};


/**
 * Preload Cesium so that it is ready when transitioning from 2D to 3D.
 * @param {number} height Target height of the camera
 * @param {number} timeout Milliseconds after which the warming will stop
 * @api
*/
olcs.OLCesium.prototype.warmUp = function(height, timeout) {
  if (this.enabled_) {
    // already enabled
    return;
  }
  this.throwOnUnitializedMap_();
  this.camera_.readFromView();
  var ellipsoid = this.globe_.ellipsoid;
  var csCamera = this.scene_.camera;
  var position = ellipsoid.cartesianToCartographic(csCamera.position);
  if (position.height < height) {
    position.height = height;
    csCamera.position = ellipsoid.cartographicToCartesian(position);
  }
  this.cesiumRenderingDelay_.start();
  var that = this;
  setTimeout(
      function() { !that.enabled_ && that.cesiumRenderingDelay_.stop(); },
      timeout);
};


/**
 * Block Cesium rendering to save resources.
 * @param {boolean} block True to block.
 * @api
*/
olcs.OLCesium.prototype.setBlockCesiumRendering = function(block) {
  if (this.blockCesiumRendering_ !== block) {
    this.blockCesiumRendering_ = block;

    // prevent the rendering delay from spinning when rendering is blocked
    if (this.cesiumRenderingDelay_) {
      if (this.blockCesiumRendering_) {
        this.cesiumRenderingDelay_.stop();
      } else {
        this.cesiumRenderingDelay_.start();
      }
    }
  }
};


/**
 * Render the globe only when necessary in order to save resources.
 * Experimental.
 * @api
 */
olcs.OLCesium.prototype.enableAutoRenderLoop = function() {
  if (!this.autoRenderLoop_) {
    this.autoRenderLoop_ = new olcs.AutoRenderLoop(this, false);
  }
};


/**
 * Get the autorender loop.
 * @return {?olcs.AutoRenderLoop}
 * @api
*/
olcs.OLCesium.prototype.getAutoRenderLoop = function() {
  return this.autoRenderLoop_;
};


/**
 * The 3D Cesium globe is rendered in a canvas with two different dimensions:
 * clientWidth and clientHeight which are the dimension on the screen and
 * width and height which are the dimensions of the drawing buffer.
 *
 * By using a resolution scale lower than 1.0, it is possible to render the
 * globe in a buffer smaller than the canvas client dimensions and improve
 * performance, at the cost of quality.
 *
 * Pixel ratio should also be taken into account; by default, a device with
 * pixel ratio of 2.0 will have a buffer surface 4 times bigger than the client
 * surface.
 *
 * @param {number} value
 * @this {olcs.OLCesium}
 * @api
 */
olcs.OLCesium.prototype.setResolutionScale = function(value) {
  value = Math.max(0, value);
  if (value !== this.resolutionScale_) {
    this.resolutionScale_ = Math.max(0, value);
    this.resolutionScaleChanged_ = true;
    if (this.autoRenderLoop_) {
      this.autoRenderLoop_.restartRenderLoop();
    }
  }
};


/**
 * Set the target frame rate for the renderer.
 * @param {number|undefined} value The frame rate, in frames per second
 */
olcs.OLCesium.prototype.setTargetFrameRate = function(value) {
  if (this.cesiumRenderingDelay_) {
    this.cesiumRenderingDelay_.dispose();
    this.cesiumRenderingDelay_ = null;
  }

  if (!goog.isDefAndNotNull(value)) {
    // no limit - animate frames as the application allows
    this.cesiumRenderingDelay_ = new goog.async.AnimationDelay(this.render_, undefined, this);
  } else if (value > 0) {
    // use a delay to prevent the renderer from falling behind. the delay will be started after rendering
    // completes, while a timer more strictly adheres to the interval.
    this.cesiumRenderingDelay_ = new goog.async.Delay(this.render_, 1000 / value, this);
  }

  if (this.enabled_ && this.cesiumRenderingDelay_) {
    this.cesiumRenderingDelay_.start();
  }
};


/**
 * Check if OL3 map is not properly initialized.
 * @private
 */
olcs.OLCesium.prototype.throwOnUnitializedMap_ = function() {
  var map = this.map_;
  var view = map.getView();
  var center = view.getCenter();
  if (!view.isDef() || isNaN(center[0]) || isNaN(center[1])) {
    throw new Error('The OL3 map is not properly initialized: ' +
        center + ' / ' + view.getResolution());
  }
};
