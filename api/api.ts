import {
  clientApi,
  RefreshTokenAuth,
  RingRestClient,
  SessionOptions,
} from './rest-client'
import { Location } from './location'
import {
  ActiveDing,
  BaseStation,
  BeamBridge,
  CameraData,
  ChimeData,
  UserLocation,
} from './ring-types'
import { RingCamera } from './ring-camera'
import { RingChime } from './ring-chime'
import { EMPTY, merge, Subject } from 'rxjs'
import { debounceTime, switchMap, throttleTime } from 'rxjs/operators'
import { enableDebug } from './util'
import { setFfmpegPath } from './ffmpeg'

export interface RingApiOptions extends SessionOptions {
  locationIds?: string[]
  cameraStatusPollingSeconds?: number
  cameraDingsPollingSeconds?: number
  locationModePollingSeconds?: number
  debug?: boolean
  ffmpegPath?: string
  externalPorts?: {
    start: number
    end: number
  }
}

export class RingApi {
  public readonly restClient = new RingRestClient(this.options)
  public readonly onRefreshTokenUpdated = this.restClient.onRefreshTokenUpdated.asObservable()

  private locations = this.fetchAndBuildLocations()

  constructor(public readonly options: RingApiOptions & RefreshTokenAuth) {
    if (options.debug) {
      enableDebug()
    }

    const { externalPorts, ffmpegPath } = options

    if (typeof externalPorts === 'object') {
      const { start, end } = externalPorts,
        portConfigIssues: string[] = []

      if (!start || !end) {
        portConfigIssues.push('start and end must both be defined')
      }

      if (start >= end) {
        portConfigIssues.push('start must be larger than end')
      }

      if (start < 1024) {
        portConfigIssues.push(
          'start must be larger than 1024, preferably larger than 10000 to avoid conflicts'
        )
      }

      if (end > 65535) {
        portConfigIssues.push('end must be smaller than 65536')
      }

      if (portConfigIssues.length) {
        throw new Error(
          'Invalid externalPorts config: ' + portConfigIssues.join('; ')
        )
      }
    }

    if (ffmpegPath) {
      setFfmpegPath(ffmpegPath)
    }
  }

  async fetchRingDevices() {
    const {
      doorbots,
      chimes,
      authorized_doorbots: authorizedDoorbots,
      stickup_cams: stickupCams,
      base_stations: baseStations,
      beams_bridges: beamBridges,
    } = await this.restClient.request<{
      doorbots: CameraData[]
      chimes: ChimeData[]
      authorized_doorbots: CameraData[]
      stickup_cams: CameraData[]
      base_stations: BaseStation[]
      beams_bridges: BeamBridge[]
    }>({ url: clientApi('ring_devices') })

    return {
      doorbots,
      chimes,
      authorizedDoorbots,
      stickupCams,
      allCameras: doorbots.concat(stickupCams, authorizedDoorbots),
      baseStations,
      beamBridges,
    }
  }

  fetchActiveDings() {
    return this.restClient.request<ActiveDing[]>({
      url: clientApi('dings/active'),
    })
  }

  private listenForDeviceUpdates(cameras: RingCamera[], chimes: RingChime[]) {
    const {
        cameraStatusPollingSeconds,
        cameraDingsPollingSeconds,
      } = this.options,
      onCamerasRequestUpdate = merge(
        ...cameras.map((camera) => camera.onRequestUpdate)
      ),
      onChimesRequestUpdate = merge(
        ...chimes.map((chime) => chime.onRequestUpdate)
      ),
      onCamerasRequestActiveDings = merge(
        ...cameras.map((camera) => camera.onRequestActiveDings)
      ),
      onUpdateReceived = new Subject(),
      onActiveDingsReceived = new Subject(),
      onPollForStatusUpdate = cameraStatusPollingSeconds
        ? onUpdateReceived.pipe(debounceTime(cameraStatusPollingSeconds * 1000))
        : EMPTY,
      onPollForActiveDings = cameraDingsPollingSeconds
        ? onActiveDingsReceived.pipe(
            debounceTime(cameraDingsPollingSeconds * 1000)
          )
        : EMPTY,
      camerasById = cameras.reduce((byId, camera) => {
        byId[camera.id] = camera
        return byId
      }, {} as { [id: number]: RingCamera }),
      chimesById = chimes.reduce((byId, chime) => {
        byId[chime.id] = chime
        return byId
      }, {} as { [id: number]: RingChime })

    if (!cameras.length && !chimes.length) {
      return
    }

    merge(onCamerasRequestUpdate, onChimesRequestUpdate, onPollForStatusUpdate)
      .pipe(
        throttleTime(500),
        switchMap(async () => {
          const response = await this.fetchRingDevices().catch(() => null)
          return response
        })
      )
      .subscribe((response) => {
        onUpdateReceived.next()

        if (!response) {
          return
        }

        response.allCameras.forEach((data) => {
          const camera = camerasById[data.id]
          if (camera) {
            camera.updateData(data)
          }
        })

        response.chimes.forEach((data) => {
          const chime = chimesById[data.id]
          if (chime) {
            chime.updateData(data)
          }
        })
      })

    if (cameraStatusPollingSeconds) {
      onUpdateReceived.next() // kick off polling
    }

    merge(onCamerasRequestActiveDings, onPollForActiveDings).subscribe(
      async () => {
        const activeDings = await this.fetchActiveDings().catch(() => null)
        onActiveDingsReceived.next()

        if (!activeDings || !activeDings.length) {
          return
        }

        activeDings.forEach((activeDing) => {
          const camera = camerasById[activeDing.doorbot_id]
          if (camera) {
            camera.processActiveDing(activeDing)
          }
        })
      }
    )

    if (cameras.length && cameraDingsPollingSeconds) {
      onActiveDingsReceived.next() // kick off polling
    }
  }

  async fetchRawLocations() {
    const { user_locations: rawLocations } = await this.restClient.request<{
      user_locations: UserLocation[]
    }>({ url: 'https://app.ring.com/rhq/v1/devices/v1/locations' })

    return rawLocations
  }

  async fetchAndBuildLocations() {
    const rawLocations = await this.fetchRawLocations(),
      {
        authorizedDoorbots,
        chimes,
        doorbots,
        allCameras,
        baseStations,
        beamBridges,
      } = await this.fetchRingDevices(),
      locationIdsWithHubs = [...baseStations, ...beamBridges].map(
        (x) => x.location_id
      ),
      cameras = allCameras.map(
        (data) =>
          new RingCamera(
            data,
            doorbots.includes(data) ||
              authorizedDoorbots.includes(data) ||
              data.kind.startsWith('doorbell'),
            this.restClient
          )
      ),
      ringChimes = chimes.map((data) => new RingChime(data, this.restClient)),
      locations = rawLocations
        .filter((location) => {
          return (
            !Array.isArray(this.options.locationIds) ||
            this.options.locationIds.includes(location.location_id)
          )
        })
        .map(
          (location) =>
            new Location(
              location,
              cameras.filter(
                (x) => x.data.location_id === location.location_id
              ),
              ringChimes.filter(
                (x) => x.data.location_id === location.location_id
              ),
              {
                hasHubs: locationIdsWithHubs.includes(location.location_id),
                hasAlarmBaseStation: baseStations.some(
                  (station) => station.location_id === location.location_id
                ),
                locationModePollingSeconds: this.options
                  .locationModePollingSeconds,
              },
              this.restClient
            )
        )

    this.listenForDeviceUpdates(cameras, ringChimes)

    return locations
  }

  getLocations() {
    return this.locations
  }

  async getCameras() {
    const locations = await this.locations
    return locations.reduce(
      (cameras, location) => [...cameras, ...location.cameras],
      [] as RingCamera[]
    )
  }
}
