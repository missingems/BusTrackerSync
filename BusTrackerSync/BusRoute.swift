import CoreLocation
import Polyline

public struct BusRoute: Identifiable, Equatable, Hashable {
  public let id: String
  public let busStopInfos: [[BusStopInfo]]
  public var polyline: [Polyline]
  
  public static func == (lhs: BusRoute, rhs: BusRoute) -> Bool {
    return lhs.id == rhs.id
  }
  
  public func hash(into hasher: inout Hasher) {
    hasher.combine(id)
  }
  
  public var dictionary: [String: Any] {
    [
      "busStops": busStopInfos.map({$0.compactMap({$0.dictionary})}),
      "numberOfRoutes": Set(busStopInfos.map({$0.compactMap({$0.direction})})).count
    ]
  }
}

public extension BusRoute {
  struct BusStopInfo: Identifiable, Hashable {
    public let busStop: BusStop?
    public let timetable: [Timetable]
    public let distance: CLLocationDistance
    public let direction: Int
    
    public var id: String {
      return busStop?.id ?? UUID().uuidString
    }
    
    public func hash(into hasher: inout Hasher) {
      hasher.combine(id)
      hasher.combine(direction)
    }
    
    public static func == (lhs: BusRoute.BusStopInfo, rhs: BusRoute.BusStopInfo) -> Bool {
      return lhs.id == rhs.id && lhs.direction == rhs.direction
    }
    
    var dictionary: [String: Any?] {
      [
        "id": id,
        "timetable": timetable.map({$0.dictionary}),
      ]
    }
  }
}

public extension BusRoute {
  enum Timetable: Equatable, Encodable {
    enum CodingKeys: String, CodingKey {
      case weekdayFirstBus
      case weekdayLastBus
      case saturdayFirstBus
      case saturdayLastBus
      case sundayFirstBus
      case sundayLastBus
    }
    case weekday(firstBusTime: String, lastBusTime: String)
    case saturday(firstBusTime: String, lastBusTime: String)
    case sunday(firstBusTime: String, lastBusTime: String)
    
    public func encode(to encoder: Encoder) throws {
      var container = encoder.container(keyedBy: CodingKeys.self)
      
      switch self {
      case let .weekday(firstBusTime, lastBusTime):
        try container.encode(firstBusTime, forKey: .weekdayFirstBus)
        try container.encode(lastBusTime, forKey: .weekdayLastBus)
        
      case let .saturday(firstBusTime, lastBusTime):
        try container.encode(firstBusTime, forKey: .saturdayFirstBus)
        try container.encode(lastBusTime, forKey: .saturdayLastBus)
        
      case let .sunday(firstBusTime, lastBusTime):
        try container.encode(firstBusTime, forKey: .sundayFirstBus)
        try container.encode(lastBusTime, forKey: .sundayLastBus)
      }
    }
  }
}

internal struct BusRouteStopInfo: Decodable, Identifiable, Hashable {
  enum CodingKeys: String, CodingKey {
    case id = "ServiceNo"
    case direction = "Direction"
    case busStopId = "BusStopCode"
    case weekdayFirstBusTime = "WD_FirstBus"
    case weekdayLastBusTime = "WD_LastBus"
    case saturdayFirstBusTime = "SAT_FirstBus"
    case saturdayLastBusTime = "SAT_LastBus"
    case sundayFirstBusTime = "SUN_FirstBus"
    case sundayLastBusTime = "SUN_LastBus"
    case distance = "Distance"
  }
  
  let id: String
  let direction: Int
  let busStopId: String
  let weekdayFirstBusTime: String
  let weekdayLastBusTime: String
  let saturdayFirstBusTime: String
  let saturdayLastBusTime: String
  let sundayFirstBusTime: String
  let sundayLastBusTime: String
  let distance: CLLocationDistance?
}

internal struct BusRouteStopPayload: Decodable {
  let value: [BusRouteStopInfo]
}

extension Array where Element == BusRouteStopInfo {
  func groupByBusId(allBusStops: [BusStop], completion: @escaping ([BusRoute]) -> Void) {
    var busRoutes: [BusRoute] = []
    var infos = self
    
    while infos.isEmpty == false {
      print(infos.count)
      if let info = infos.first {
        let busServices = infos.filter { $0.id == info.id }
        let busRouteStopInfos = busServices.map { busRouteStopInfo in
          BusRoute.BusStopInfo(
            busStop: allBusStops.first(where: { $0.id == busRouteStopInfo.busStopId }),
            timetable: [
              .weekday(
                firstBusTime: busRouteStopInfo.weekdayFirstBusTime,
                lastBusTime: busRouteStopInfo.weekdayLastBusTime
              ),
              .saturday(
                firstBusTime: busRouteStopInfo.saturdayFirstBusTime,
                lastBusTime: busRouteStopInfo.saturdayLastBusTime
              ),
              .sunday(
                firstBusTime: busRouteStopInfo.sundayFirstBusTime,
                lastBusTime: busRouteStopInfo.sundayLastBusTime
              ),
            ],
            distance: busRouteStopInfo.distance ?? 0,
            direction: busRouteStopInfo.direction
          )
        }
        
        busRoutes.append(
          BusRoute(
            id: info.id,
            busStopInfos: busRouteStopInfos.splitByDirection(),
            polyline: []
          )
        )
        infos = Array(infos[busServices.count..<infos.count])
        if infos.isEmpty {
          completion(busRoutes)
        }
      }
    }
  }
}

extension Array where Element == BusRoute.BusStopInfo {
  func splitByDirection() -> [[BusRoute.BusStopInfo]] {
    var direction1: [BusRoute.BusStopInfo] = []
    var direction2: [BusRoute.BusStopInfo] = []
    
    for busStopInfo in self {
      if busStopInfo.direction == 1 {
        direction1.append(busStopInfo)
      } else if busStopInfo.direction == 2 {
        direction2.append(busStopInfo)
      }
    }
    
    let infos = [direction1, direction2].filter {
      $0.isEmpty == false
    }
    
    if infos.isLoop {
      return split()
    } else {
      return infos
    }
  }
}

extension Array where Element == [BusRoute.BusStopInfo] {
  private var isLoop: Bool {
    count == 1 && (first?.first == last?.last)
  }
  
  var isOneDirectional: Bool {
    isOneDirectionalSplitted && count == 1
  }
  
  var isOneDirectionalSplitted: Bool {
    Set(flatMap { $0 }.map { $0.direction }).count == 1
  }
}


extension Array {
  func split() -> [[Element]] {
    let ct = self.count
    let half = ct / 2
    let leftSplit = self[0 ..< half]
    let rightSplit = self[half ..< ct]
    return [Array(leftSplit), Array(rightSplit)]
  }
}

public extension Encodable {
  var dictionary: [String: Any]? {
    guard let data = try? JSONEncoder().encode(self) else { return nil }
    return (try? JSONSerialization.jsonObject(with: data, options: .allowFragments)).flatMap { $0 as? [String: Any] }
  }
}
