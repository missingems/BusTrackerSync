import Foundation
import TinyNetworking

enum BusRouteServiceTask {
  case busRoutes(page: Int)
}

extension BusRouteServiceTask: Resource {
  var baseURL: URL {
    URL(string: "http://datamall2.mytransport.sg")!
  }
  
  var endpoint: Endpoint {
    switch self {
    case .busRoutes:
      return .get(path: "/ltaodataservice/BusRoutes")
    }
  }
 
  var task: Task {
    switch self {
    case let .busRoutes(page):
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
