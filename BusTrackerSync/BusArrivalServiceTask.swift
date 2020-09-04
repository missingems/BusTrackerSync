import Foundation
import TinyNetworking

enum BusArrivalServiceTask {
  case busArrival(busStopCode: String)
}

extension BusArrivalServiceTask: Resource {
  var baseURL: URL {
    URL(string: "http://datamall2.mytransport.sg")!
  }
  
  var endpoint: Endpoint {
    switch self {
    case .busArrival:
      return .get(path: "/ltaodataservice/BusArrivalv2")
    }
  }
 
  var task: Task {
    switch self {
    case let .busArrival(busStopCode):
      return .requestWithParameters(
        ["BusStopCode": busStopCode],
        encoding: URLEncoding()
      )
    }
  }
  
  var headers: [String: String] {
    ["AccountKey": "aA9akqkcToOUH1UZKRo4Fg=="]
  }
  
  var cachePolicy: URLRequest.CachePolicy {
    .useProtocolCachePolicy
  }
}
