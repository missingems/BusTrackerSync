import Foundation
import TinyNetworking

enum BusStopServiceTask {
  case busStops(page: Int)
}

extension BusStopServiceTask: Resource {
  var baseURL: URL {
    URL(string: "http://datamall2.mytransport.sg")!
  }
  
  var endpoint: Endpoint {
    switch self {
    case .busStops:
      return .get(path: "/ltaodataservice/BusStops")
    }
  }
 
  var task: Task {
    switch self {
    case let .busStops(page):
      return .requestWithParameters(["page": page], encoding: URLEncoding())
    }
  }
  
  var headers: [String: String] {
    ["AccountKey": "aA9akqkcToOUH1UZKRo4Fg=="]
  }
  
  var cachePolicy: URLRequest.CachePolicy {
    .useProtocolCachePolicy
  }
}
