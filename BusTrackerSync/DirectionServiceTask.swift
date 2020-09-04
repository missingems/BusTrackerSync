import Foundation
import TinyNetworking
import CoreLocation

enum DirectionServiceTask {
  case bus(service: String, direction: Int)
}

extension DirectionServiceTask: Resource {
  var baseURL: URL {
    URL(string: "https://developers.onemap.sg/publicapi/busexp")!
  }
  
  var endpoint: Endpoint {
    switch self {
    case .bus:
      return .get(path: "/getOneBusRoute")
    }
  }
 
  var task: Task {
    switch self {
    case let .bus(service, direction):
      return .requestWithParameters(
        [
          "token": "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJzdWIiOjMsInVzZXJfaWQiOjMsImVtYWlsIjoicHVibGljQXBpUm9sZUBzbGEuZ292LnNnIiwiZm9yZXZlciI6ZmFsc2UsImlzcyI6Imh0dHA6XC9cL29tMi5kZmUub25lbWFwLnNnXC9hcGlcL3YyXC91c2VyXC9zZXNzaW9uIiwiaWF0IjoxNTk4NzI2Njc4LCJleHAiOjE1OTkxNTg2NzgsIm5iZiI6MTU5ODcyNjY3OCwianRpIjoiNjA0ZjE2NGFlY2Q5ZDA0Y2ZkZWQ0ZmU0ZjM5M2ZhOTMifQ.LkI5K3dmaCvbFFtN0IVYsaH2TwLmwK5jjRgTCTow51M",
          "busNo": service,
          "direction": direction,
        ],
        encoding: URLEncoding()
      )
    }
  }
  
  var headers: [String: String] {
    [:]
  }
  
  var cachePolicy: URLRequest.CachePolicy {
    .useProtocolCachePolicy
  }
}
