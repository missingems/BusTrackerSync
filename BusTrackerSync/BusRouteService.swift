import Combine
import TinyNetworking
import CoreLocation
import Polyline

final class BusRouteService {
  private let network = TinyNetworking<BusRouteServiceTask>()
  private let directionNetwork = TinyNetworking<DirectionServiceTask>()
  private var busRoutesSubject = PassthroughSubject<[BusRoute], TinyNetworkingError>()
  private var busRoutePolylineSubject = PassthroughSubject<BusRoute, Never>()
  private var disposables: Set<AnyCancellable> = []
  init() {}
  
  func loadBusRoutes(page: Int) -> AnyPublisher<BusRouteStopPayload, TinyNetworkingError> {
    return network
      .requestPublisher(resource: .busRoutes(page: page))
      .map(to: BusRouteStopPayload.self)
  }
  
  func loadAllBusRoutes(allBusStops: [BusStop]) -> PassthroughSubject<[BusRoute], TinyNetworkingError> {
    func recursePage(_ page: Int, aggregatedPayload: BusRouteStopPayload) {
      loadBusRoutes(page: page)
        .sink(receiveCompletion: { _ in
      }) { [weak self] payload in
        guard let self = self else {
          return
        }

        if payload.value.count >= 500 {
          print(page)
          let aggregatedPayloadValue = aggregatedPayload.value
          let newPayloadValue = aggregatedPayloadValue + payload.value
          recursePage(page + 1, aggregatedPayload: BusRouteStopPayload(value: newPayloadValue))
        } else {
          let aggregatedPayloadValue = aggregatedPayload.value
          let newPayloadValue = aggregatedPayloadValue + payload.value

          DispatchQueue.global().async {
            newPayloadValue.groupByBusId(allBusStops: allBusStops) { busRoutes in
              DispatchQueue.main.async {
                var output: [String: Any] = [:]
                busRoutes.forEach { (busRoute) in
                  output[busRoute.id] = busRoute.busStopInfos.map({$0.compactMap({$0.busStop?.id})})
                }
                self.writeServiceStops(output: output)
                self.busRoutesSubject.send(busRoutes)
              }
            }
          }
        }
      }.store(in: &disposables)
    }
    
    recursePage(1, aggregatedPayload: BusRouteStopPayload(value: []))
    return busRoutesSubject
  }
  
  func loadDirectionForAllBusRoutes(_ allBusRoutes: [BusRoute], completion: @escaping ([BusRoute]) -> Void) {
    func recurse(index: Int, busRoutes: [BusRoute]) {
      if index >= allBusRoutes.count {
        var output: [String: [String]] = [:]
        busRoutes.forEach { (busRoute) in
          output[busRoute.id] = busRoute.polyline.map({$0.encodedPolyline})
        }
        completion(busRoutes)
        writeOutput(output: output)
        return
      }
      
      loadDirectionForBusRoute(allBusRoutes[index]) { (busRoute) in
        var copiedBusRoutes = busRoutes
        copiedBusRoutes.append(busRoute)
        
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
          recurse(index: index + 1, busRoutes: copiedBusRoutes)
        }
      }
    }
    
    recurse(index: 0, busRoutes: [])
  }
  
  func loadDirectionForBusRoute(_ busRoute: BusRoute, completion: @escaping (BusRoute) -> Void) {
    func getPolyline(
      service: String,
      infos: [BusRoute.BusStopInfo],
      completion: @escaping (String, [CLLocationCoordinate2D]) -> Void
    ) {
      let direction = infos[0].direction
      
      directionNetwork.request(
        resource: .bus(service: service, direction: direction)
      ) { result in
        switch result {
        case let .success(response):
          do {
            let sequence = try response.map(to: RoutePayload.self)
            let coordinates: [CLLocationCoordinate2D]
            if sequence.coordinates.isEmpty {
              coordinates = infos.compactMap { $0.busStop?.coordinate }
              print("no route for \(service), fall back to bus stop coordinate")
            } else {
              coordinates = sequence.coordinates
            }
            completion(service, coordinates)
          } catch {
            print(error)
          }
          
        case let .failure(error):
          print(error)
        }
      }
    }
    
    var copiedBusRoute = busRoute
    print("downloading polyline for \(busRoute.id)")
    
    if busRoute.busStopInfos.isOneDirectionalSplitted {
      getPolyline(service: busRoute.id, infos: busRoute.busStopInfos[0]) { (service, coordinates) in
        if copiedBusRoute.id == service {
          if busRoute.busStopInfos.isOneDirectional {
            copiedBusRoute.polyline = [Polyline(coordinates: coordinates)]
            print("one way: downloaded polyline for \(busRoute.id)")
          } else {
            copiedBusRoute.polyline = coordinates.split().map { Polyline(coordinates: $0) }
            print("loop: downloaded polyline for \(busRoute.id)")
          }
          
          completion(copiedBusRoute)
        }
      }
    } else {
      getPolyline(service: busRoute.id, infos: busRoute.busStopInfos[0]) { (service, coordinates1) in
        getPolyline(service: busRoute.id, infos: busRoute.busStopInfos[1]) { (service, coordinates2) in
          if copiedBusRoute.id == service {
            copiedBusRoute.polyline = [
              .init(coordinates: coordinates1),
              .init(coordinates: coordinates2),
            ]
            print("2 way: downloaded polyline for \(busRoute.id)")
            completion(copiedBusRoute)
          }
        }
      }
    }
  }
  
  func getDocumentsDirectory() -> URL {
    let paths = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)
    return paths[0]
  }
  
  func writeOutput(output: [String: [String]]) {
    if let jsonData = try? JSONSerialization.data(withJSONObject: output, options: [.prettyPrinted]) {
      if let jsonString = String(data: jsonData, encoding: .utf8) {
        let filename = self.getDocumentsDirectory().appendingPathComponent("busRoutes.json")

        do {
          try jsonString.write(to: filename, atomically: true, encoding: String.Encoding.utf8)
          print("done \(output.count)")
        } catch {
          print(error)
        }
      }
    }
  }
  
  func writeServiceStops(output: [String: Any]) {
    if let jsonData = try? JSONSerialization.data(withJSONObject: output, options: [.prettyPrinted]) {
      if let jsonString = String(data: jsonData, encoding: .utf8) {
        let filename = self.getDocumentsDirectory().appendingPathComponent("serviceStops.json")

        do {
          try jsonString.write(to: filename, atomically: true, encoding: String.Encoding.utf8)
          print("done \(output.count)")
        } catch {
          print(error)
        }
      }
    }
  }
}
